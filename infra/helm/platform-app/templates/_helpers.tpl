{{/*
Names and labels. The release name is the app name (core, admin, storefront, mock-store, …), set by
the ArgoCD Application, so resources are simply <release>.
*/}}

{{- define "platform-app.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform-app.labels" -}}
app.kubernetes.io/name: {{ include "platform-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: commerce-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "platform-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "platform-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "platform-app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- include "platform-app.name" . -}}
{{- else -}}
default
{{- end -}}
{{- end -}}

{{- define "platform-app.secretName" -}}
{{- if .Values.externalSecrets.secretName -}}
{{- .Values.externalSecrets.secretName -}}
{{- else -}}
{{- printf "%s-env" (include "platform-app.name" .) -}}
{{- end -}}
{{- end -}}

{{/*
Fail early and loudly on the values a deployment cannot invent. A missing image tag would otherwise
render a manifest that ArgoCD happily syncs and Kubernetes then rejects, or worse, silently keeps
the previous ReplicaSet.
*/}}
{{- define "platform-app.validate" -}}
{{- if not .Values.image.repository -}}
{{- fail "image.repository is required (the ECR repository URL from the terraform output ecr_repository_urls)" -}}
{{- end -}}
{{/*
`toString` is not decoration: a git sha can be forty digits with no letters, and YAML reads that as a
number. Comparing a number to a string fails the render with "incompatible types for comparison" —
which is how this was found, on a placeholder tag of all zeroes.
*/}}
{{- $tag := toString .Values.image.tag -}}
{{- if or (not $tag) (eq $tag "<nil>") -}}
{{- fail "image.tag is required and must be a git sha — never `latest`, or the cluster and the repository disagree about what is running" -}}
{{- end -}}
{{- if eq $tag "latest" -}}
{{- fail "image.tag must be a git sha, not `latest`" -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) -}}
{{- fail "ingress.host is required when ingress.enabled is true" -}}
{{- end -}}
{{- end -}}
