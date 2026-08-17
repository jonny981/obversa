# Graph Runtime Positioning

Status: working product position  
Competitor snapshot: 14 August 2026

## Category

The planned package is a product-neutral graph runtime for long-running AI
work.

It is not a software factory, editor, or hosted agent platform.

Obversa is a host product that will use the runtime. Other products can use the
same public package.

## Product promise

> Bring your own graph topology. Keep one trusted runtime.

Users can define how work moves through a graph. The runtime gives every graph
the same execution, evidence, resume, playback, and safety rules.

## Market map

The products overlap, but their main units are different.

| Project | Main unit | Strongest public capability | Position against this runtime |
| --- | --- | --- | --- |
| Foreman | One software-factory recipe | A ready issue-to-draft-change flow with isolated stations | A useful recipe pattern, not a general graph kernel |
| Eve | A durable agent conversation | Sessions, steps, tools, sandboxes, subagents, channels, and human input | A close agent-runtime competitor with a conversation-first design |
| LangGraph | A compiled state graph | Durable stateful agent graphs with streaming and human input | The closest graph-runtime competitor |
| Mastra | A schema-defined workflow | Typed steps, control flow, streaming, suspend, and resume in a broad TypeScript AI framework | A broad framework with workflow execution |
| Planned runtime | A compiled graph type | Replaceable graph meaning over one event-backed node runtime | A narrower graph kernel with stronger proof and replay goals |

This comparison describes public material on the snapshot date. It does not
claim that the planned runtime features exist before version `1.0.0` passes.

## Planned differences

### Graph meaning is replaceable

Most graph tools let users change nodes and edges inside one graph model.

This runtime also lets a package define what an edge means, when a node can
run, and when the graph is complete. Built-in graph types use the same public
contract.

### The run plan is frozen

The runtime stores the resolved graph, policies, package digests, permissions,
engines, and result schemas before execution.

An edit creates a new graph version. It does not change an active run.

### Events explain decisions

Domain events decide graph state. Telemetry only reports activity.

Playback folds the original events and performs no effects. Resume checks code,
graph, policy, permission, and result-schema changes before it continues.

### Branches bind decisions to files

A named start point binds an event revision to a verified workspace anchor. A
child run starts from both versions together.

One logical workspace provider can anchor more than one repository. The graph
kernel does not need to know how the provider does this.

### Review is reusable proof

Each review seat binds its verdict to exact inputs, proof scope, reviewer
behavior, and workspace content.

A repair reruns only stale or rejected seats. Changed bytes invalidate only the
proof that used them.

## What creates a moat

Architecture alone is not a moat.

The moat starts when these assets exist together:

1. Public conformance kits for graph types, stores, engines, workspaces, and
   human interactions.
2. A crash matrix that proves every built-in graph can resume without guessing.
3. A field corpus from long, expensive, and failure-prone production runs.
4. Reusable graph types, evidence recipes, and outside adapters built by users.
5. Obversa as a complete host that designs, runs, inspects, and improves these
   graphs.

The first three assets make behavior hard to copy quickly. The last two create
an ecosystem and product loop.

Conversation-first runtimes need a deeper change to make graph meaning pure and
replaceable. LangGraph starts closer to this design. The runtime must beat it
with proof quality, replay rules, extension tests, and operational results.

## Response to Foreman and Eve

Use these patterns:

- Give each station fixed inputs, tools, and structured results.
- Review an exact output revision in an independent context.
- Resolve caller trust before model-readable input is built.
- Make the action policy return `allow`, `wait`, or `deny`.
- Stop unattended work at a draft or evidence boundary.

Do not copy these boundaries into the kernel:

- Prompt text as the scheduler.
- A model verdict as completion proof.
- Repository comments as the run record.
- One hosted sandbox or model provider as a required path.
- One fixed factory sequence as a graph type.

Foreman is a good version-1 example recipe. Eve can connect through an
execution adapter. Neither requires a new kernel abstraction.

## Build order

1. Build and test the pure graph contract and node runtime.
2. Prove durable events, resume, review reuse, and workspace safety.
3. Run demanding production automation through the packed package.
4. Prove an outside host through public APIs only.
5. Use the stable package to build Obversa.

Do not build a hosted control plane, marketplace, or general desktop shell to
answer a competitor announcement.

## Sources

- [Foreman documentation](https://ask-foreman.dev/docs)
- [Foreman template source](https://github.com/vercel-labs/eve-software-factory-template)
- [Vercel software-factory case study](https://vercel.com/blog/building-a-software-factory-for-ai-sdk)
- [Eve source and overview](https://github.com/vercel/eve)
- [Eve execution and durability](https://github.com/vercel/eve/blob/main/docs/concepts/execution-model-and-durability.mdx)
- [LangGraph overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Mastra workflow overview](https://mastra.ai/docs/workflows/overview)
