{{- define "tickets.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "tickets.labels" -}}
app.kubernetes.io/name: {{ include "tickets.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app: {{ include "tickets.name" . }}
{{- end -}}

{{- define "tickets.selectorLabels" -}}
app: {{ include "tickets.name" . }}
{{- end -}}
