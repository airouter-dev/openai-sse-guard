# Releasing

1. Update the version in jsr.json and deno.json.
2. Update CHANGELOG.md with user-visible behavior and documentation changes.
3. Run `deno task verify`.
4. Commit the release and create an annotated vX.Y.Z tag.
5. Push main and the tag.

The publish workflow uses JSR GitHub Actions OIDC. Before the first publish, an
owner must create the @ai-router scope and package in JSR, link it to
airouter-dev/openai-sse-guard, and select publish.yml as the trusted workflow.
Do not add a long-lived JSR token to the repository or workflow.
