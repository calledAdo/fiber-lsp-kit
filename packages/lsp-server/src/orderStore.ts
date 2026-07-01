/** In-memory order store. Swap for a persistent one in production; the interface is all the LSP needs. */
import type { Order } from "@fiberlsp/protocol";

export interface OrderStore {
  put(order: Order): void;
  get(id: string): Order | undefined;
  all(): Order[];
}

export class MemoryOrderStore implements OrderStore {
  private orders = new Map<string, Order>();

  put(order: Order): void {
    this.orders.set(order.order_id, order);
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  all(): Order[] {
    return [...this.orders.values()];
  }
}
