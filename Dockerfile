FROM node:14-alpine

WORKDIR /app
COPY . .

# assume PST
RUN apk add --no-cache tzdata
ENV TZ=America/Los_Angeles

# needed for github dependencies
RUN apk add git
RUN apk add openssh-client

# warm cache for github.com in known_hosts
RUN mkdir ~/.ssh
RUN ssh-keyscan -Ht ecdsa github.com >> ~/.ssh/known_hosts

# package-lock forces it to only use ssh to clone, for some reason
RUN rm package-lock.json

# install dependencies
RUN npm install

# instructions on how to start - this does not fire at image build time
CMD ["node", "app.mjs"]
