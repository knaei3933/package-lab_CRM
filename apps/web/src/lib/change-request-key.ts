/**
 * UI batch F: the (order, design) key shared by the server page
 * (lib/change-request) and the client form (components/ChangeRequestFields).
 * Client-safe on purpose: no server or @kanei/core import.
 */
export function changeRequestKey(orderId: string, designKey: string): string {
  return `${orderId}\u0000${designKey.trim()}`;
}
