/**
 * "Ativar notificações", etapa por etapa.
 *
 * No iPhone qualquer uma das etapas pode simplesmente não responder (o pedido de
 * permissão, a ativação do service worker, a inscrição no serviço da Apple).
 * Por isso cada etapa tem um tempo-limite e uma mensagem própria: a tela sempre
 * diz onde parou, e o hub recebe o mesmo relato para aparecer no diagnóstico.
 */

export type PushStep = 'support' | 'permission' | 'service-worker' | 'key' | 'subscribe' | 'register' | 'done';

export const STEP_LABEL: Record<PushStep, string> = {
  support: 'Conferindo o aparelho…',
  permission: 'Pedindo permissão ao iPhone…',
  'service-worker': 'Ativando o serviço de notificações do app…',
  key: 'Lendo a chave do hub…',
  subscribe: 'Inscrevendo o aparelho no serviço de push…',
  register: 'Registrando a inscrição no hub…',
  done: 'Notificações ativadas.',
};

/** Tempo máximo de cada etapa, em ms. Todos abaixo de 15 s. */
export const STEP_TIMEOUT: Record<Exclude<PushStep, 'support' | 'done'>, number> = {
  permission: 12_000,
  'service-worker': 10_000,
  key: 8_000,
  subscribe: 12_000,
  register: 8_000,
};

/** Depois do aviso de demora, quanto ainda se espera pela resposta ao pedido de permissão. */
const PERMISSION_HARD_LIMIT = 90_000;

const STALL_MESSAGE: Record<keyof typeof STEP_TIMEOUT, string> = {
  permission:
    'O iPhone não respondeu ao pedido de permissão. Se o aviso do iOS está na tela, responda nele. Se nenhum aviso apareceu, feche o app (deslize para cima), abra de novo pelo ícone da Tela de Início e tente outra vez.',
  'service-worker': 'O serviço de notificações do app não ativou. Feche o app, abra de novo pelo ícone da Tela de Início e tente outra vez.',
  key: 'O hub não respondeu ao pedido da chave de push. Confira se o Tailscale está ligado no iPhone.',
  subscribe:
    'A Apple não devolveu a inscrição de push. Confira a conexão do iPhone com a internet e, em Ajustes → Notificações, se o Claude Hub aparece na lista.',
  register: 'O hub não confirmou o registro da inscrição. Confira se o Tailscale está ligado no iPhone.',
};

export class PushStepError extends Error {
  constructor(
    readonly step: PushStep,
    readonly outcome: 'failed' | 'stalled',
    message: string,
  ) {
    super(message);
  }
}

export interface PushDiagnostics {
  /** `Notification.permission`, ou "unsupported". */
  permission: 'default' | 'granted' | 'denied' | 'unsupported';
  serviceWorker: 'unsupported' | 'none' | 'installing' | 'waiting' | 'active';
  /** Aberto pelo ícone da Tela de Início. */
  standalone: boolean;
  /** Existe inscrição de push neste aparelho. */
  subscribed: boolean;
  /** Erro do registro do service worker feito ao abrir o app, se houve. */
  registrationError: string | null;
}

export const PERMISSION_LABEL: Record<PushDiagnostics['permission'], string> = {
  default: 'ainda não pedida',
  granted: 'concedida',
  denied: 'negada',
  unsupported: 'indisponível neste navegador',
};

export const WORKER_LABEL: Record<PushDiagnostics['serviceWorker'], string> = {
  unsupported: 'indisponível',
  none: 'não registrado',
  installing: 'instalando',
  waiting: 'aguardando',
  active: 'ativo',
};

export function pushApiPresent(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

function timeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const stalled = (step: keyof typeof STEP_TIMEOUT) => new PushStepError(step, 'stalled', STALL_MESSAGE[step]);

function errorText(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}

let registrationError: string | null = null;
let registration: Promise<ServiceWorkerRegistration> | null = null;

/**
 * Registra o service worker. Chamado ao abrir o app, para que no toque em
 * "Ativar notificações" ele já esteja ativo — e de novo no toque, por garantia.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error('service worker indisponível'));
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
    (reg) => {
      registrationError = null;
      return reg;
    },
    (err: unknown) => {
      registrationError = errorText(err);
      registration = null;
      throw err;
    },
  );
  return registration;
}

function workerState(reg: ServiceWorkerRegistration | undefined): PushDiagnostics['serviceWorker'] {
  if (!reg) return 'none';
  if (reg.active) return 'active';
  if (reg.waiting) return 'waiting';
  if (reg.installing) return 'installing';
  return 'none';
}

/** Estado atual, para mostrar na tela e mandar ao hub. Nunca fica pendente. */
export async function pushDiagnostics(): Promise<PushDiagnostics> {
  const base: PushDiagnostics = {
    permission: typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
    serviceWorker: 'unsupported',
    standalone: isStandalone(),
    subscribed: false,
    registrationError,
  };
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return base;
  try {
    const reg = await timeout(navigator.serviceWorker.getRegistration('/'), 3000, () => new Error('sem resposta'));
    base.serviceWorker = workerState(reg);
    if (reg && 'pushManager' in reg) {
      base.subscribed = Boolean(await timeout(reg.pushManager.getSubscription(), 3000, () => new Error('sem resposta')));
    }
  } catch {
    /* fica com o que já se sabe */
  }
  return base;
}

/**
 * Pede a permissão. Precisa rodar dentro do toque do usuário (exigência do iOS):
 * nada assíncrono pode vir antes desta chamada.
 */
function askPermission(): Promise<NotificationPermission> {
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return new Promise<NotificationPermission>((resolve, reject) => {
    const done = (value?: NotificationPermission) => resolve(value ?? Notification.permission);
    try {
      // Versões antigas do Safari só chamam o callback; as novas devolvem uma promise.
      const result = Notification.requestPermission(done) as Promise<NotificationPermission> | undefined;
      if (result && typeof result.then === 'function') result.then(done, reject);
    } catch (err) {
      reject(err as Error);
    }
  });
}

/** Espera o service worker ficar ativo, sem depender só de `serviceWorker.ready`. */
function waitActive(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (reg.active) finish();
      else if (!reg.installing && !reg.waiting) {
        // Nada instalando e nada ativo: o iOS descartou a instalação.
        finish(new PushStepError('service-worker', 'failed', 'O iOS descartou a instalação do serviço de notificações do app. Feche o app e abra de novo.'));
      }
    };
    const poll = setInterval(check, 250);
    for (const worker of [reg.installing, reg.waiting]) worker?.addEventListener('statechange', check);
    navigator.serviceWorker.ready.then(() => finish(), () => undefined);
  });
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface EnableDeps {
  /** GET /api/push/public-key */
  publicKey(): Promise<string | null>;
  /** POST /api/push/subscribe */
  register(subscription: PushSubscriptionJSON): Promise<void>;
  /** A etapa em andamento; `stalledMessage` quando ela passou do tempo mas ainda pode responder. */
  onProgress(step: PushStep, stalledMessage?: string): void;
}

/**
 * Ativa as notificações. Rejeita com `PushStepError` dizendo a etapa e o motivo.
 * IMPORTANTE: chame direto do manipulador do toque, sem `await` antes.
 */
export function enablePush(deps: EnableDeps): Promise<void> {
  if (!pushApiPresent()) {
    return Promise.reject(new PushStepError('support', 'failed', 'Este navegador não oferece notificações push. No iPhone, abra o app pelo ícone da Tela de Início.'));
  }
  // Síncrono, ainda dentro do toque.
  deps.onProgress('permission');
  let permission: Promise<NotificationPermission>;
  try {
    permission = askPermission();
  } catch (err) {
    return Promise.reject(new PushStepError('permission', 'failed', `O iPhone recusou o pedido de permissão: ${errorText(err)}`));
  }
  // Aproveita a espera pela resposta para já ir registrando o service worker.
  const early = registerServiceWorker().catch(() => null);
  return finishEnable(deps, permission, early);
}

async function finishEnable(deps: EnableDeps, permission: Promise<NotificationPermission>, early: Promise<ServiceWorkerRegistration | null>): Promise<void> {
  // 1. Permissão. Passado o tempo, avisa — mas continua esperando: o aviso do iOS pode estar na tela.
  let granted: NotificationPermission;
  const slow = setTimeout(() => deps.onProgress('permission', STALL_MESSAGE.permission), STEP_TIMEOUT.permission);
  try {
    granted = await timeout(permission, PERMISSION_HARD_LIMIT, () => stalled('permission'));
  } catch (err) {
    if (err instanceof PushStepError) throw err;
    throw new PushStepError('permission', 'failed', `O iPhone recusou o pedido de permissão: ${errorText(err)}`);
  } finally {
    clearTimeout(slow);
  }
  if (granted === 'denied') {
    throw new PushStepError('permission', 'failed', 'As notificações estão bloqueadas para este app. Libere em Ajustes do iPhone → Notificações → Claude Hub e tente de novo.');
  }
  if (granted !== 'granted') {
    throw new PushStepError('permission', 'failed', 'O pedido de permissão foi fechado sem resposta. Toque em "Ativar notificações" de novo e escolha Permitir.');
  }

  // 2. Service worker ativo.
  deps.onProgress('service-worker');
  let reg: ServiceWorkerRegistration;
  try {
    reg = await timeout(
      (async () => {
        const ready = (await early) ?? (await registerServiceWorker());
        await waitActive(ready);
        return ready;
      })(),
      STEP_TIMEOUT['service-worker'],
      () => stalled('service-worker'),
    );
  } catch (err) {
    if (err instanceof PushStepError) throw err;
    throw new PushStepError('service-worker', 'failed', `O serviço de notificações do app não pôde ser registrado: ${errorText(err)}`);
  }

  // 3. Chave pública do hub.
  deps.onProgress('key');
  let publicKey: string | null;
  try {
    publicKey = await timeout(deps.publicKey(), STEP_TIMEOUT.key, () => stalled('key'));
  } catch (err) {
    if (err instanceof PushStepError) throw err;
    throw new PushStepError('key', 'failed', `O hub recusou o pedido da chave de push: ${errorText(err)}`);
  }
  if (!publicKey) throw new PushStepError('key', 'failed', 'O hub está sem chaves de push. No Mac: Configuração e saúde → Reparar.');

  // 4. Inscrição no serviço de push (no iPhone, a Apple).
  deps.onProgress('subscribe');
  const options: PushSubscriptionOptionsInit = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  let subscription: PushSubscription;
  try {
    subscription = await timeout(
      (async () => {
        const existing = await reg.pushManager.getSubscription();
        if (existing) return existing;
        try {
          return await reg.pushManager.subscribe(options);
        } catch (err) {
          // Sobrou uma inscrição feita com outra chave: desfaz e tenta uma vez.
          if ((err as Error)?.name !== 'InvalidStateError') throw err;
          await (await reg.pushManager.getSubscription())?.unsubscribe();
          return reg.pushManager.subscribe(options);
        }
      })(),
      STEP_TIMEOUT.subscribe,
      () => stalled('subscribe'),
    );
  } catch (err) {
    if (err instanceof PushStepError) throw err;
    throw new PushStepError('subscribe', 'failed', `O serviço de push recusou a inscrição: ${errorText(err)}`);
  }

  // 5. Registro no hub.
  deps.onProgress('register');
  try {
    await timeout(deps.register(subscription.toJSON()), STEP_TIMEOUT.register, () => stalled('register'));
  } catch (err) {
    if (err instanceof PushStepError) throw err;
    throw new PushStepError('register', 'failed', `O hub recusou a inscrição: ${errorText(err)}`);
  }
  deps.onProgress('done');
}
