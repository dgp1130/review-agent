See relevant docs as appropriate:
* [README.md](/README.md) - Project overview and local development.
* [docs/design.md](/docs/design.md) - Design and architecture.
* [docs/plan.md](/docs/plan.md) - High-level implementation plan.

This is a Jujutsu project, use `jj` for all VCS commands.

Do not assume you can modify the root workspace. Create your own workspace
in the `.workspaces/` directory before writing any code or running any commands.

```shell
jj workspace add .workspaces/my-feature
```
