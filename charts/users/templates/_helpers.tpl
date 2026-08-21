{{- define "users.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "users.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride -}}
{{- else -}}
{{- .Release.Name -}}
{{- end -}}
{{- end -}}

{{- define "users.labels" -}}
app.kubernetes.io/name: {{ include "users.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app: {{ include "users.name" . }}
{{- end -}}

{{- define "users.selectorLabels" -}}
app: {{ include "users.name" . }}
{{- end -}}
