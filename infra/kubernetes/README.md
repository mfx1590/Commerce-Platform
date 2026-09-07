# infra/kubernetes

Raw manifests that are not part of a Helm chart. Charts and ArgoCD applications arrive with task 2.3
(issue #33).

- `bootstrap-db/` — Job that creates the `platform_app` database role with the password Terraform
  generated, before the migrations run. See `bootstrap-db/bootstrap.sql` for why it exists: the
  migration that creates the role only does so when it is missing, and its built-in password is a
  local-development default that must never reach a cloud environment.

  ```bash
  kubectl kustomize infra/kubernetes/bootstrap-db | kubectl apply -n commerce -f -
  kubectl logs -n commerce job/bootstrap-db
  ```

  It needs the `platform-database-owner` and `platform-database-app` secrets, which External Secrets
  projects from AWS Secrets Manager (task 2.6). Until that exists, create them by hand from the
  Terraform outputs — the runbook in `infra/README.md` has the exact commands.
