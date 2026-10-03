# Build the web app. Node 26 ships without corepack, so pnpm comes from npm,
# pinned to package.json's packageManager.
FROM node:26-alpine AS web
WORKDIR /app/web
RUN npm install -g pnpm@11.28.3
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
COPY web/packages/timeclock/package.json ./packages/timeclock/
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

# Build the server, embedding the web build (package web, //go:embed all:dist).
FROM golang:1.27-alpine AS server
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /app/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -o timeclock-server ./cmd/timeclock-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /app/timeclock-server /timeclock-server
ENV PORT=8080
EXPOSE 8080
CMD ["/timeclock-server"]
