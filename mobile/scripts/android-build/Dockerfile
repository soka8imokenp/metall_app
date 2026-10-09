# Образ для сборки APK без установки Android SDK на хост:
# Android SDK + JDK (cirruslabs) и Node 22 (его зовёт Gradle-плагин React Native для сборки JS).
FROM ghcr.io/cirruslabs/android-sdk:36
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils curl ca-certificates \
 && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
 && rm -rf /var/lib/apt/lists/* && node -v
WORKDIR /app
