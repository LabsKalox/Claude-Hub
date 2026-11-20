// Lista os donos das janelas visíveis (nomes de processo). Usado pelos testes para
// saber se o app realmente abriu — um processo listado não basta: quando o macOS
// bloqueia a abertura, só existe a janela de aviso do sistema.
// Nomes de processo não exigem permissão de Gravação de Tela.
import CoreGraphics
import Foundation

let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let owners = Set(list.compactMap { $0[kCGWindowOwnerName as String] as? String })
print(owners.sorted().joined(separator: ","))
