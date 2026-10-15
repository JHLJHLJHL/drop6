/** Minimal observable state holder, shaped for React's useSyncExternalStore. */
export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  getState = (): T => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected update(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
