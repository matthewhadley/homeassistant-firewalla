ARG BUILD_FROM
FROM $BUILD_FROM

# RUN apk add websocat

COPY config.yaml /
RUN grep version < config.yaml | grep -oe '[0-9\.]*' > VERSION && rm config.yaml

ENV LANG C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

COPY package.json /
COPY app.js /
RUN npm install --unsafe-perm


COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]