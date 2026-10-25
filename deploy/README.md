# Deployment

| | Local | Dev | Prod |
|---|---|---|---|
| Branch | `feature/*`, `hotfix/*` | `develop` | `main` |
| Runs on | your laptop (`npm run dev`) | Render free tier (`render.yaml`) | 1× EC2 t4g.small (this folder) |
| Database | local Docker Postgres | Neon branch `dev` | Neon branch `main` |
| Redis | none | none | Valkey on the server |
| `NODE_ENV` / Cashfree | development / sandbox | development / sandbox | production / production |
| Deploys | — | push to `develop`, after CI passes | push to `main`, after CI passes (`deploy-prod.yml`) |

## Branch workflow

1. New work: `git checkout develop && git pull && git checkout -b feature/<name>`, then a PR into `develop`. Merging deploys dev.
2. Release: a PR from `develop` into `main`. Merging deploys prod.
3. Urgent prod fix: `hotfix/<name>` from `main`, PR into `main`, then merge `main` back into `develop`.

Every migration must keep working with the previous code: `deploy.sh` runs it while the old api is still serving. Add a column in one release; drop the old one in a later release.

## Prod server

```
Cloudflare (TLS, tunnel) ──▶ EC2 t4g.small: api + valkey + cloudflared (docker compose) ──▶ Neon, S3, Agora, Cashfree
```

A deploy restarts the api: about 5–15s in which requests fail and sockets reconnect. Billing jobs live in Valkey, so calls continue as long as the restart is shorter than `CALL_DISCONNECT_GRACE_MS` (20s). Deploy off-peak.

## One-time AWS setup

Use one region throughout, the same as the Neon project.

1. **ECR**: create a private repository `triloplan-api`, with a lifecycle rule that keeps the last 10 images.
2. **SSM parameters** (SecureString, all free):
   - `/triloplan/prod/app/<NAME>`: one per app setting from `.env.example`. Examples: `/triloplan/prod/app/DATABASE_URL` (Neon `main` branch, pooled URL), `NODE_ENV=production`, `CASHFREE_ENV=production`, `BACKEND_PUBLIC_URL`.
     - Multi-line values (`CASHFREE_PAYOUT_PUBLIC_KEY`, `FIREBASE_PRIVATE_KEY`) are stored on one line with `\n` escapes.
     - Use `CASHFREE_PAYOUT_PUBLIC_KEY`, not `..._PATH`: there is no `secrets/` folder in the image.
   - `/triloplan/prod/cloudflare-tunnel-token`: from step 5.
3. **Server IAM role** (`triloplan-prod-server`). Attach `AmazonSSMManagedInstanceCore` and `AmazonEC2ContainerRegistryReadOnly`, plus this inline policy:
   ```json
   {"Version": "2012-10-17", "Statement": [
     {"Effect": "Allow", "Action": ["ssm:GetParametersByPath", "ssm:GetParameter"],
      "Resource": ["arn:aws:ssm:<region>:<account>:parameter/triloplan/prod/*", "arn:aws:ssm:<region>:<account>:parameter/triloplan/prod"]}
   ]}
   ```
4. **Launch the server**:
   - Amazon Linux 2023 (arm64), t4g.small, 20 GB gp3 disk;
   - the role from step 3, a public IP, and a security group with **no inbound rules**;
   - user data = `setup-server.sh`.

   Then:
   - create a CloudWatch alarm on `StatusCheckFailed_System` with the EC2 **Recover** action;
   - add a Data Lifecycle Manager policy for daily disk snapshots, keeping 7.
5. **Cloudflare**: Zero Trust → Networks → Tunnels → create a tunnel (docker). Copy its token into step 2. Add a public hostname `api.<your domain>` → `http://api:4000`.
6. **GitHub → AWS (OIDC)**: add the identity provider `token.actions.githubusercontent.com`. Then create the role `triloplan-github-deploy`.
   - Trust it only for this repo's `production` environment: `"token.actions.githubusercontent.com:sub": "repo:Chinarayudu/triloapp_plan:environment:production"`.
   - Give it this policy:
   ```json
   {"Version": "2012-10-17", "Statement": [
     {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
     {"Effect": "Allow", "Action": ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
       "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Resource": "arn:aws:ecr:<region>:<account>:repository/triloplan-api"},
     {"Effect": "Allow", "Action": "ssm:SendCommand",
      "Resource": ["arn:aws:ec2:<region>:<account>:instance/<instance id>", "arn:aws:ssm:<region>::document/AWS-RunShellScript"]},
     {"Effect": "Allow", "Action": "ssm:GetCommandInvocation", "Resource": "*"}
   ]}
   ```
7. **GitHub settings**:
   - Create an environment `production` with variables `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN` and `PROD_INSTANCE_ID`.
   - Add required reviewers if your GitHub plan offers them for this repo. Without them, a merge to `main` deploys straight away.
   - Protect `main` and `develop`: changes only through PRs, with the `build-and-test` check required.
8. **Spend**: an AWS Budgets alert at $25/month. Point a free uptime monitor (UptimeRobot) at `https://api.<your domain>/health`.

## Dev (Render)

The Render service deploys `develop` (`render.yaml`). Point its `DATABASE_URL` at the Neon `dev` branch. Dev never gets prod keys.

## Useful commands on the server (SSM Session Manager)

```bash
cd /opt/triloplan
sudo docker compose ps
sudo docker compose logs -f --tail 200 api
sudo docker compose restart api
```
