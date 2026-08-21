{{- define "notifications.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "notifications.labels" -}}
app.kubernetes.io/name: {{ include "notifications.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app: {{ include "notifications.name" . }}
{{- end -}}

{{- define "notifications.selectorLabels" -}}
app: {{ include "notifications.name" . }}
{{- end -}}
