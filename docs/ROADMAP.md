# StellarCortex roadmap

Planned work is not shipped functionality. Nothing here authorizes deployment, host security changes or infrastructure provisioning. The current feature set is in [PARITY.md](PARITY.md).

## Separate computers for individual bots

Today, host-control bots share the OS user and filesystem, and virtual computers share one Ubuntu guest with separate unprivileged users ([SHARED-DESKTOP.md](SHARED-DESKTOP.md)). The goal is an optional environment per bot on the StellarCortex host: ephemeral (deleted after a task) or persistent, with explicit per-bot access to private and shared files.

- Execution-environment providers for Linux and suitable VPS hosts, with capability reporting when a host cannot run a chosen backend.
- Docker, Podman, KVM and Hyper-V are candidates, not selected dependencies.

Open questions: container versus VM guarantees and host requirements (including nested virtualization); lifecycle and persistence; file sharing and access control; credential and integration boundaries; resource limits, startup cost and verified cleanup. Root inside a guest is not root on the host, and deleting a guest does not prove that provider logs, backups or shared files are gone.

## Kanban automation

The board, projects, stages, routing and approval gates are implemented, and bot work on a card starts only on an explicit action. Still open: fully automatic stage progression, fair scheduling across projects based on measured CPU/RAM, and the exact semantics of project versus task pause, cancellation and checkpoint recovery. Resource-aware scheduling must not promise hard CPU/RAM isolation unless an OS boundary enforces it.

## Platform

1. A durable database with paging, streaming recovery and migration tests for large histories.
2. Lower-latency desktop streaming and stronger per-bot filesystem isolation.
3. A connector registry, per-service event subscriptions and a secrets vault.
5. Multi-user access control, shared knowledge, audit policy and administration.
