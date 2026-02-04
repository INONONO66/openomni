import { z } from "zod";

export namespace BusEvent {
  export interface Descriptor<T> {
    name: string;
    schema: z.ZodSchema<T>;
  }

  export function define<T>(
    name: string,
    schema: z.ZodSchema<T>,
  ): Descriptor<T> {
    return { name, schema };
  }
}

export namespace Bus {
  type Handler = (data: any) => void;

  const subscribers = new Map<string, Set<Handler>>();

  export function publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    const handlers = subscribers.get(event.name);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch {
        // handler errors must not affect other handlers
      }
    }
  }

  export function subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
  ): () => void {
    let handlers = subscribers.get(event.name);
    if (!handlers) {
      handlers = new Set();
      subscribers.set(event.name, handlers);
    }
    handlers.add(handler as Handler);
    return () => {
      handlers!.delete(handler as Handler);
    };
  }

  export function reset(): void {
    subscribers.clear();
  }
}
