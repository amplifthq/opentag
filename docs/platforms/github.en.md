# GitHub Setup

Use this guide when `opentag setup` asks for GitHub settings.

## What You Need

- A GitHub repository in `owner/repo` form.
- A public URL that forwards GitHub webhooks to your local OpenTag GitHub ingress.
- A webhook secret.
- A GitHub token that lets OpenTag post callbacks.

For local testing, expose OpenTag with a tunnel:

```bash
ngrok http 3000
```

Your GitHub webhook URL should look like:

```text
https://<your-tunnel-host>/github/webhooks
```

## Repository

OpenTag asks for:

```text
GitHub repository (owner/repo)
```

Use the repository name from the GitHub URL:

```text
https://github.com/amplifthq/opentag
```

In that example, enter:

```text
amplifthq/opentag
```

## Webhook Secret

1. Open the repository on GitHub.
2. Go to **Settings** -> **Webhooks**.
3. Add a webhook.
4. Set **Payload URL** to:

```text
https://<your-tunnel-host>/github/webhooks
```

5. Set **Content type** to `application/json`.
6. Enter a strong random **Secret** and keep it for OpenTag.
7. Subscribe to:
   - **Issue comments**
   - **Pull request review comments**
8. Save the webhook.

OpenTag asks for that value as:

```text
GitHub webhook secret
```

## GitHub Token

OpenTag uses the token to post acknowledgements and final results back to GitHub.

For a fine-grained personal access token, grant access to the target repository and include:

- **Issues**: Read and write
- **Pull requests**: Read and write
- **Contents**: Read and write, if you want OpenTag to create branches or pull requests

OpenTag asks for this as:

```text
GitHub token for callbacks
```

## Test

After setup, start OpenTag:

```bash
opentag start
```

Then comment on an issue or pull request review thread:

```text
@opentag investigate this
```

OpenTag should create a run, execute it locally, and post the result back to the same GitHub thread.
