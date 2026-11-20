# The build stage names a patch release: the standard library is compiled into
# the binary, so a cached copy of a floating tag would ship whatever fixes it
# happened to hold.
FROM golang:1.27.4 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/server ./cmd/server

# The runtime is pinned by digest and runs as uid 65532. The untagged base
# resolved to latest, so the image under a public demo could change without a
# commit, and distroless defaults to root, which a project whose whole story is
# bounding an anonymous visitor should not ship.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
