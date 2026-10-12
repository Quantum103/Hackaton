FROM golang:1.26-alpine AS builder
WORKDIR /app

# Копируем go.mod и скачиваем зависимости
COPY go.mod ./
COPY go.sum ./
RUN go mod download

# Копируем исходный код и собираем приложение
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o stoplist-api ./internal/cmd
# Финальный легкий образ
FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /root/
COPY --from=builder /app/stoplist-api .

RUN mkdir -p /root/data && chmod 777 /root/data

ENV SQLITE_DB_PATH=/root/data/app.db
ENV PORT=8080

EXPOSE 8080
CMD ["./stoplist-api"]
