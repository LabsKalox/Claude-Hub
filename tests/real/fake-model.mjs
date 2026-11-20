#!/usr/bin/env node
/**
 * Modelo falso, local, para testar o Codex e o OpenCode DE VERDADE sem chave de
 * API e sem custo. Fala os dois dialetos da OpenAI que eles usam:
 *
 *   POST /v1/chat/completions  (stream)  — OpenCode, via @ai-sdk/openai-compatible
 *   POST /v1/responses         (stream)  — Codex, com `wire_api = "responses"`
 *
 * Roteiro fixo: no primeiro pedido de uma conversa, o "modelo" chama a ferramenta
 * de terminal com o comando de COMMAND; quando a resposta da ferramenta volta,
 * ele encerra com um texto curto. Assim o agente real precisa pedir permissão
 * para executar o comando — que é o que o Claude Hub tem de interceptar.
 *
 *   node tests/real/fake-model.mjs <porta> "<comando>"
 *
 * Cada pedido é registrado em stdout (resumido) para facilitar o diagnóstico.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);
const command = process.argv[3] ?? 'echo hub-ok > hub-test.txt';
let seq = 0;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Cabeçalhos de limite no formato que o servidor da OpenAI manda ao Codex (janela de 5 h e semanal). */
const now = () => Math.floor(Date.now() / 1000);
const RATE_HEADERS = () => ({
  'x-codex-primary-used-percent': '23',
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': String(now() + 3 * 3600),
  'x-codex-secondary-used-percent': '41',
  'x-codex-secondary-window-minutes': '10080',
  'x-codex-secondary-reset-at': String(now() + 4 * 86400),
});

/** Pedido que deve falhar: o prompt pede isso (testa o estado de erro). */
function wantsFailure(body) {
  return /FALHAR/.test(JSON.stringify(body.messages ?? body.input ?? ''));
}
function fail(res) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Pedido recusado pelo modelo falso (teste de erro)', type: 'invalid_request_error', code: 'teste_de_erro' } }));
}

/** Ferramenta de plano/lista de tarefas, se o agente oferece (Codex: update_plan; OpenCode: todowrite). */
function pickPlanTool(tools) {
  const list = (tools || []).map((t) => ({ name: t.name ?? t.function?.name, parameters: t.parameters ?? t.function?.parameters }));
  return list.find((t) => t.name === 'update_plan' || t.name === 'todowrite') ?? null;
}
function planArgs(tool) {
  const props = tool.parameters?.properties ?? {};
  if (props.plan) return { plan: [{ step: 'Criar hub-test.txt', status: 'in_progress' }, { step: 'Conferir o arquivo', status: 'pending' }] };
  const item = props.todos?.items?.properties ?? {};
  const todo = (content, status, i) => {
    const o = { content, status };
    if (item.priority) o.priority = 'medium';
    if (item.id) o.id = String(i + 1);
    if (item.activeForm) o.activeForm = content;
    return o;
  };
  return { todos: [todo('Criar hub-test.txt', 'in_progress', 0), todo('Conferir o arquivo', 'pending', 1)] };
}

function sse(res, headers = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
  return {
    event: (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`),
    data: (data) => res.write(`data: ${JSON.stringify(data)}\n\n`),
    end: (done = true) => {
      if (done) res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

/** Argumentos para a ferramenta de terminal, conforme o esquema que o agente declarou. */
function shellArgs(parameters) {
  const props = (parameters && parameters.properties) || {};
  if (props.cmd) return withEscalation({ cmd: command }, props);
  if (props.command && props.command.type === 'array') return withEscalation({ command: ['bash', '-lc', command] }, props);
  const out = { command };
  if (props.description) out.description = 'Teste do Claude Hub';
  if (props.timeout) out.timeout = 60000;
  return withEscalation(out, props);
}

/** Codex: pede para sair da sandbox (é o que faz o pedido de aprovação aparecer). */
function withEscalation(out, props) {
  if (props.sandbox_permissions) out.sandbox_permissions = 'require_escalated';
  if (props.with_escalated_permissions) out.with_escalated_permissions = true;
  if (props.justification) out.justification = 'Teste do Claude Hub: criar hub-test.txt';
  return out;
}

function pickShellTool(tools) {
  const list = (tools || []).map((t) => ({
    name: t.name ?? t.function?.name,
    parameters: t.parameters ?? t.function?.parameters,
  }));
  const pref = ['bash', 'shell', 'exec_command', 'local_shell', 'container.exec'];
  for (const name of pref) {
    const hit = list.find((t) => t.name === name);
    if (hit) return hit;
  }
  return list.find((t) => /shell|bash|exec/i.test(t.name ?? '')) ?? null;
}

// ─────────────── Chat Completions (OpenCode) ───────────────
function chat(body, res) {
  const messages = body.messages || [];
  const done = messages.filter((m) => m.role === 'tool').length;
  const steps = [pickPlanTool(body.tools), pickShellTool(body.tools)].filter(Boolean);
  const tool = steps[done] ?? null;
  log('chat', { messages: messages.length, done, tools: (body.tools || []).map((t) => t.function?.name).join(','), stream: body.stream });
  if (wantsFailure(body)) return fail(res);
  const id = `chatcmpl-${++seq}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
  const s = sse(res);
  if (tool) {
    const args = JSON.stringify(tool.name === 'update_plan' || tool.name === 'todowrite' ? planArgs(tool) : shellArgs(tool.parameters));
    s.data({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${seq}`, type: 'function', function: { name: tool.name, arguments: '' } }] }, finish_reason: null }] });
    s.data({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
    s.data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } });
  } else {
    s.data({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Pronto.' }, finish_reason: null }] });
    s.data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 140, completion_tokens: 3, total_tokens: 143 } });
  }
  s.end();
}

// ─────────────── Responses API (Codex) ───────────────
function responses(body, res) {
  const input = Array.isArray(body.input) ? body.input : [];
  const done = input.filter((i) => i && (i.type === 'function_call_output' || i.type === 'custom_tool_call_output' || i.type === 'local_shell_call_output')).length;
  const steps = [pickPlanTool(body.tools), pickShellTool(body.tools)].filter(Boolean);
  const tool = steps[done] ?? null;
  log('responses', { items: input.length, done, tools: (body.tools || []).map((t) => t.name ?? t.type).join(','), stream: body.stream });
  if (tool) log('ferramenta escolhida', tool.name, JSON.stringify(tool.parameters?.properties ?? {}).slice(0, 600));
  if (wantsFailure(body)) return fail(res);
  const id = `resp_${++seq}`;
  const usage = { input_tokens: 150, input_tokens_details: { cached_tokens: 40 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 160 };
  const s = sse(res, RATE_HEADERS());
  s.event('response.created', { response: { id, object: 'response', status: 'in_progress', model: body.model, output: [] } });
  let output;
  if (tool) {
    const args = tool.name === 'update_plan' ? planArgs(tool) : shellArgs(tool.parameters);
    const item = { type: 'function_call', id: `fc_${seq}`, call_id: `call_${seq}`, name: tool.name, arguments: JSON.stringify(args), status: 'completed' };
    s.event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
    s.event('response.output_item.done', { output_index: 0, item });
    output = [item];
  } else {
    const msg = { type: 'message', id: `msg_${seq}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Pronto.', annotations: [] }] };
    s.event('response.output_item.added', { output_index: 0, item: { ...msg, content: [], status: 'in_progress' } });
    s.event('response.output_text.delta', { item_id: msg.id, output_index: 0, content_index: 0, delta: 'Pronto.' });
    s.event('response.output_item.done', { output_index: 0, item: msg });
    output = [msg];
  }
  s.event('response.completed', { response: { id, object: 'response', status: 'completed', model: body.model, output, usage } });
  s.end(false);
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* corpo inválido */
    }
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && /\/models$/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'claude-hub' }] }));
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) return chat(body, res);
    if (req.method === 'POST' && path.endsWith('/responses')) return responses(body, res);
    log('desconhecido', req.method, path);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `rota não simulada: ${req.method} ${path}` } }));
  });
});
server.listen(port, '127.0.0.1', () => log(`modelo falso em http://127.0.0.1:${server.address().port}`));
