/** While set, navigating away from the sender screen asks first (it would stop running transfers). */
let message: string | null = null;

export function setLeaveGuard(next: string | null): void {
  message = next;
}

export function confirmLeave(): boolean {
  return message === null || window.confirm(message);
}
