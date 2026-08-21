{{- define "events.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "events.labels" -}}
app.kubernetes.io/name: {{ include "events.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app: {{ include "events.name" . }}
{{- end -}}

{{- define "events.selectorLabels" -}}
app: {{ include "events.name" . }}
{{- end -}}
