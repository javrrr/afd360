import { Construct, type Scope, type Resource } from "./construct.js";

/**
 * A ResourceConstruct wraps a Resource impl plus its authored props + dependsOn
 * references. The deploy runner walks the App → Stack → ResourceConstruct tree
 * to collect every resource and feed the graph.
 */
export interface ResourceConstruct<Props = unknown, Output = unknown>
  extends Construct {
  readonly resource: Resource<Props, Output>;
  readonly props: Props;
  readonly dependsOn: readonly Construct[];
}

export function isResourceConstruct(
  c: Construct,
): c is Construct & ResourceConstruct {
  return (
    "resource" in c &&
    "props" in c &&
    "dependsOn" in c &&
    typeof (c as { resource?: unknown }).resource === "object"
  );
}

/**
 * Plan JSON emitted by `app.synth()` and later loaded by `deploy` / `diff`.
 * Deliberately shallow and tool-agnostic so a YAML loader could emit the same
 * shape in v1.1 (see PRD §9).
 */
export interface PlanResource {
  uniqueId: string;
  type: string;
  surface: "connect" | "metadata";
  stackId: string;
  props: unknown;
  dependsOn: string[];
  hash: string;
}

export interface Plan {
  appVersion: string;
  stacks: Array<{ id: string; targetOrg: string }>;
  resources: PlanResource[];
}

export class App implements Scope {
  readonly id = "";
  readonly path: readonly string[] = [];
  readonly stacks: Stack[] = [];

  addChild(child: Construct): void {
    if (child instanceof Stack) {
      this.stacks.push(child);
    }
  }

  /**
   * Walk all stacks, collect ResourceConstructs, snapshot props + dependencies,
   * and emit a plan. This is pure — no org I/O. The plan is then consumed by
   * `afd360 diff` / `afd360 deploy`.
   */
  synth(appVersion = "0.0.1"): Plan {
    const resources: PlanResource[] = [];
    for (const stack of this.stacks) {
      for (const c of walkResources(stack)) {
        resources.push({
          uniqueId: c.uniqueId,
          type: c.resource.type,
          surface: c.resource.surface,
          stackId: stack.id,
          props: c.props,
          dependsOn: c.dependsOn.map((d) => d.uniqueId),
          hash: c.resource.hash(c.props),
        });
      }
    }
    return {
      appVersion,
      stacks: this.stacks.map((s) => ({ id: s.id, targetOrg: s.targetOrg })),
      resources,
    };
  }
}

export interface StackProps {
  targetOrg: string;
}

export class Stack extends Construct {
  readonly targetOrg: string;

  constructor(scope: App, id: string, props: StackProps) {
    super(scope, id);
    this.targetOrg = props.targetOrg;
  }
}

function* walkResources(
  root: Construct,
): Generator<Construct & ResourceConstruct> {
  if (isResourceConstruct(root)) yield root;
  for (const child of root.children) yield* walkResources(child);
}
