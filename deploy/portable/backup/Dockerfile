FROM postgres:17.10-alpine3.23@sha256:8189a1f6e40904781fc9e2612687877791d21679866db58b1de996b31fc312e4 AS runtime
RUN apk add --no-cache age aws-cli jq && \
    mkdir -p /opt/backup /work /backups && chown -R postgres:postgres /work /backups
COPY --chmod=0555 backup.sh /opt/backup/backup.sh
COPY --chmod=0444 connection.py /opt/backup/connection.py
USER postgres
ENV PGCONNECT_TIMEOUT=15 AWS_EC2_METADATA_DISABLED=true
WORKDIR /work
ENTRYPOINT ["/opt/backup/backup.sh"]
CMD ["create"]
