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
{{- $digest := toString .Values.image.digest -}}
{{- $hasTag := and $tag (ne $tag "<nil>") -}}
{{- $hasDigest := and $digest (ne $digest "<nil>") -}}
{{- if and (not $hasTag) (not $hasDigest) -}}
{{- fail "image needs a tag (our images: a git sha) or a digest (third-party images) — never neither, or the cluster and the repository disagree about what is running" -}}
{{- end -}}
{{- if and $hasTag (eq $tag "latest") -}}
{{- fail "image.tag must be a git sha, not `latest`" -}}
{{- end -}}
{{- if and $hasDigest (not (hasPrefix "sha256:" $digest)) -}}
{{- fail "image.digest must look like sha256:… — a bare hex string is not a valid image reference" -}}
{{- end -}}
{{- if and .Values.service.probe (not (has .Values.service.probe (list "httpGet" "tcpSocket"))) -}}
{{- fail "service.probe must be httpGet or tcpSocket" -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) -}}
{{- fail "ingress.host is required when ingress.enabled is true" -}}
{{- end -}}
{{- end -}}

{{/*
One place that turns image values into a reference. A digest pins a third-party image to an exact
manifest; a tag is how our own images are versioned, because CI knows the git sha and not the digest
until after the push.
*/}}
{{- define "platform-app.image" -}}
{{- $digest := toString .Values.image.digest -}}
{{- if and $digest (ne $digest "<nil>") -}}
{{- printf "%s@%s" .Values.image.repository $digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (toString .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/*
The probe stanza, shared by all three probes so they cannot drift apart. tcpSocket exists for the
Prism mocks: every path they serve answers 401 without credentials, and Kubernetes treats anything
outside 200-399 as a failed probe, so an httpGet probe would hold readiness red and let liveness
restart a perfectly healthy pod.
*/}}
{{- define "platform-app.probeAction" -}}
{{- if eq (default "httpGet" .Values.service.probe) "tcpSocket" -}}
tcpSocket:
  port: http
{{- else -}}
httpGet:
  path: {{ .Values.service.healthPath }}
  port: http
{{- end -}}
{{- end -}}
