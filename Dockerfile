FROM scratch AS source
COPY . /

FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
WORKDIR /app
RUN npm install --global npm@11.11.1
COPY --from=source /package.json /package-lock.json /.npmrc /.node-version ./
RUN npm ci --no-audit --no-fund
COPY --from=source / ./
RUN npm run container:check && npm run build && npm run check:artifacts

FROM nginx/nginx-unprivileged:1.30.6-alpine@sha256:2daef144b574804198caccc4041819fa1801ecd5df2252a39646bfa2b1ff3bea AS runtime
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/ /usr/share/clipbraid/
COPY --from=build /app/reports/build-artifacts.json /opt/clipbraid/build-artifacts.json
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/clipbraid/
COPY licenses/ /usr/share/licenses/clipbraid/dependencies/
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/healthz"]
