export interface GraphInput {
  /** Stable node identifiers — e.g. a Construct uniqueId. */
  readonly nodes: readonly string[];
  /** Directed edges: `from` must be deployed before `to`. */
  readonly edges: readonly { from: string; to: string }[];
}

export class CycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
  }
}

export class UnknownNodeError extends Error {
  constructor(readonly node: string, readonly edge: string) {
    super(`Edge references unknown node "${node}" (edge: ${edge})`);
    this.name = "UnknownNodeError";
  }
}

/**
 * Topologically sort an unweighted DAG. Kahn's algorithm — produces a deploy
 * order in which every resource comes after its dependencies.
 *
 * On cycle, DFS-finds the offending loop and throws `CycleError` with the path.
 */
export function topologicalSort(input: GraphInput): string[] {
  const nodeSet = new Set(input.nodes);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();

  for (const n of input.nodes) {
    outgoing.set(n, []);
    incoming.set(n, 0);
  }

  for (const { from, to } of input.edges) {
    if (!nodeSet.has(from)) throw new UnknownNodeError(from, `${from} -> ${to}`);
    if (!nodeSet.has(to)) throw new UnknownNodeError(to, `${from} -> ${to}`);
    outgoing.get(from)!.push(to);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }

  const queue: string[] = [];
  // Stable order: iterate input.nodes so deterministic regardless of edge order.
  for (const n of input.nodes) {
    if ((incoming.get(n) ?? 0) === 0) queue.push(n);
  }

  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of outgoing.get(n) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== input.nodes.length) {
    const leftover = input.nodes.filter((n) => (incoming.get(n) ?? 0) > 0);
    throw new CycleError(findCycle(leftover, outgoing));
  }

  return order;
}

/**
 * Reverse a topological order for teardown. Resources destroy children before
 * their parents (walks the DAG the other way).
 */
export function reverseTopologicalSort(input: GraphInput): string[] {
  return topologicalSort(input).reverse();
}

function findCycle(
  candidates: string[],
  outgoing: Map<string, string[]>,
): string[] {
  // DFS from each candidate to locate one concrete cycle.
  for (const start of candidates) {
    const stack: string[] = [start];
    const inStack = new Set<string>([start]);
    const visited = new Set<string>();
    const result = dfs(start, outgoing, stack, inStack, visited);
    if (result) return result;
  }
  // Fallback — the "no progress" set, with the first element repeated so the
  // error message is unambiguous.
  return [...candidates, candidates[0] ?? "<unknown>"];
}

function dfs(
  node: string,
  outgoing: Map<string, string[]>,
  stack: string[],
  inStack: Set<string>,
  visited: Set<string>,
): string[] | null {
  for (const next of outgoing.get(node) ?? []) {
    if (inStack.has(next)) {
      const startIdx = stack.indexOf(next);
      return [...stack.slice(startIdx), next];
    }
    if (visited.has(next)) continue;
    stack.push(next);
    inStack.add(next);
    const found = dfs(next, outgoing, stack, inStack, visited);
    if (found) return found;
    stack.pop();
    inStack.delete(next);
    visited.add(next);
  }
  return null;
}
