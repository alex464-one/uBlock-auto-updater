// ==UserScript==
// @name         uBlock Origin — GitHub Auto Updater
// @namespace    local.ublock.updater
// @version      1.1.0
// @description  Проверяет стабильные релизы uBlock Origin через JSON-манифест и скачивает проверенный CRX
// @author       User
// @homepageURL  https://github.com/alex464-one/uBlock-auto-updater
// @updateURL    https://github.com/alex464-one/uBlock-auto-updater/releases/latest/download/ublock-auto-updater.user.js
// @downloadURL  https://github.com/alex464-one/uBlock-auto-updater/releases/latest/download/ublock-auto-updater.user.js
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      github.com
// @connect      objects.githubusercontent.com
// @connect      release-assets.githubusercontent.com
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        manifestUrl: 'https://github.com/alex464-one/uBlock-auto-updater/releases/latest/download/ublock-update.json',
        releaseDownloadBase: 'https://github.com/alex464-one/uBlock-auto-updater/releases/latest/download/',
        expectedExtensionId: 'ioadkgmoekakepbdfldgeckpiplpgkmj',
        expectedSourceRepository: 'gorhill/uBlock',
        checkIntervalMs: 6 * 60 * 60 * 1000,
        requestRetryIntervalMs: 15 * 60 * 1000,
        downloadRetryIntervalMs: 30 * 60 * 1000,
        requestTimeoutMs: 30000,
        downloadRequestTimeoutMs: 120000,
        repeatedCheckIntervalMs: 30 * 60 * 1000,
        lockDurationMs: 60 * 1000,
        errorNoticeIntervalMs: 6 * 60 * 60 * 1000,
    });

    // Эти ключи совместимы с версией 1.0. Остальные данные имеют новые ключи,
    // чтобы старый 12-часовой кэш GitHub API не мешал переходу на JSON.
    const STORAGE = Object.freeze({
        installedVersion: 'installedVersion',
        pendingVersion: 'pendingVersion',
        manifestCache: 'manifestCacheV1',
        manifestCheckedAt: 'manifestCheckedAtV1',
        manifestAttemptAt: 'manifestAttemptAtV1',
        downloadAttemptAt: 'downloadAttemptAtV1',
        checkLockUntil: 'checkLockUntilV1',
        lastErrorNoticeAt: 'lastErrorNoticeAtV1',
    });

    let isChecking = false;
    let isDownloading = false;

    function notify(message, timeout = 10000) {
        GM_notification({
            title: 'uBlock Origin Updater',
            text: String(message),
            timeout,
        });
    }

    function normalizeVersion(value) {
        if (typeof value !== 'string') {
            throw new Error('Версия отсутствует или имеет неверный тип.');
        }

        const normalized = value.trim()
            .replace(/^uBlock-/i, '')
            .replace(/^v/i, '');

        if (!/^\d+(?:\.\d+){1,3}$/.test(normalized)) {
            throw new Error('Неподдерживаемый формат версии: ' + value);
        }

        return normalized;
    }

    function compareVersions(left, right) {
        const a = normalizeVersion(left).split('.').map(Number);
        const b = normalizeVersion(right).split('.').map(Number);
        const length = Math.max(a.length, b.length);

        for (let index = 0; index < length; index += 1) {
            const av = a[index] ?? 0;
            const bv = b[index] ?? 0;

            if (av > bv) return 1;
            if (av < bv) return -1;
        }

        return 0;
    }

    function validateManifest(manifest) {
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            throw new Error('JSON-манифест имеет неверный формат.');
        }

        if (manifest.schema_version !== 1) {
            throw new Error('Неподдерживаемая версия JSON-манифеста.');
        }

        const version = normalizeVersion(manifest.version);

        if (version !== manifest.version) {
            throw new Error('Версия в манифесте должна быть нормализована.');
        }

        if (manifest.tag !== 'uBlock-' + version) {
            throw new Error('Тег релиза не соответствует версии в манифесте.');
        }

        if (manifest.extension_id !== CONFIG.expectedExtensionId) {
            throw new Error('Extension ID в манифесте не совпадает с ожидаемым.');
        }

        const expectedCrxName = `uBlock0_${version}.chromium.crx`;

        if (manifest.crx !== expectedCrxName) {
            throw new Error('Имя CRX в манифесте не соответствует версии.');
        }

        if (
            typeof manifest.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(manifest.sha256)
        ) {
            throw new Error('В манифесте отсутствует корректная SHA-256.');
        }

        if (manifest.source_repository !== CONFIG.expectedSourceRepository) {
            throw new Error('Неожиданный исходный репозиторий uBlock.');
        }

        if (
            typeof manifest.source_commit !== 'string' ||
            !/^[a-f0-9]{7,40}$/i.test(manifest.source_commit)
        ) {
            throw new Error('В манифесте отсутствует корректный исходный commit.');
        }

        return Object.freeze({
            schema_version: 1,
            version,
            tag: manifest.tag,
            extension_id: manifest.extension_id,
            crx: expectedCrxName,
            sha256: manifest.sha256.toLowerCase(),
            source_commit: manifest.source_commit,
            source_repository: manifest.source_repository,
        });
    }

    function requestManifest(onSuccess, onFailure) {
        const separator = CONFIG.manifestUrl.includes('?') ? '&' : '?';
        const url = CONFIG.manifestUrl + separator + 'cache_bust=' + Date.now();

        GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers: {
                'Accept': 'application/json',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },
            nocache: true,
            revalidate: true,
            timeout: CONFIG.requestTimeoutMs,

            onload(response) {
                try {
                    if (response.status !== 200) {
                        throw new Error('GitHub HTTP ' + response.status);
                    }

                    const text = response.responseText || response.response;
                    const parsed = typeof text === 'string'
                        ? JSON.parse(text)
                        : text;

                    onSuccess(validateManifest(parsed));
                } catch (error) {
                    onFailure(error);
                }
            },

            onerror() {
                onFailure(new Error('Не удалось подключиться к GitHub.'));
            },

            ontimeout() {
                onFailure(new Error('Истекло время ожидания ответа GitHub.'));
            },

            onabort() {
                onFailure(new Error('Запрос манифеста был прерван.'));
            },
        });
    }

    function bytesToHex(bytes) {
        return Array.from(
            bytes,
            byte => byte.toString(16).padStart(2, '0')
        ).join('');
    }

    // Основной путь использует Web Crypto. Запасной SHA-256 нужен для HTTP-страниц,
    // где crypto.subtle может быть недоступен из-за требований secure context.
    async function sha256Hex(bytes) {
        if (globalThis.crypto && globalThis.crypto.subtle) {
            const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
            return bytesToHex(new Uint8Array(digest));
        }

        return sha256Fallback(bytes);
    }

    function sha256Fallback(input) {
        const constants = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
            0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
            0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
            0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
            0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
            0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
            0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
            0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
            0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];

        const hash = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ];

        const bitLength = input.length * 8;
        const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
        const data = new Uint8Array(paddedLength);

        data.set(input);
        data[input.length] = 0x80;

        const view = new DataView(data.buffer);

        view.setUint32(
            paddedLength - 8,
            Math.floor(bitLength / 0x100000000),
            false
        );

        view.setUint32(
            paddedLength - 4,
            bitLength >>> 0,
            false
        );

        const rotateRight = (value, amount) =>
            (value >>> amount) | (value << (32 - amount));

        const words = new Uint32Array(64);

        for (let offset = 0; offset < paddedLength; offset += 64) {
            for (let index = 0; index < 16; index += 1) {
                words[index] = view.getUint32(offset + index * 4, false);
            }

            for (let index = 16; index < 64; index += 1) {
                const x = words[index - 15];
                const y = words[index - 2];

                const s0 =
                    rotateRight(x, 7) ^
                    rotateRight(x, 18) ^
                    (x >>> 3);

                const s1 =
                    rotateRight(y, 17) ^
                    rotateRight(y, 19) ^
                    (y >>> 10);

                words[index] = (
                    words[index - 16] +
                    s0 +
                    words[index - 7] +
                    s1
                ) >>> 0;
            }

            let a = hash[0];
            let b = hash[1];
            let c = hash[2];
            let d = hash[3];
            let e = hash[4];
            let f = hash[5];
            let g = hash[6];
            let h = hash[7];

            for (let index = 0; index < 64; index += 1) {
                const sum1 =
                    rotateRight(e, 6) ^
                    rotateRight(e, 11) ^
                    rotateRight(e, 25);

                const choice = (e & f) ^ (~e & g);

                const temp1 = (
                    h +
                    sum1 +
                    choice +
                    constants[index] +
                    words[index]
                ) >>> 0;

                const sum0 =
                    rotateRight(a, 2) ^
                    rotateRight(a, 13) ^
                    rotateRight(a, 22);

                const majority =
                    (a & b) ^
                    (a & c) ^
                    (b & c);

                const temp2 = (sum0 + majority) >>> 0;

                h = g;
                g = f;
                f = e;
                e = (d + temp1) >>> 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) >>> 0;
            }

            hash[0] = (hash[0] + a) >>> 0;
            hash[1] = (hash[1] + b) >>> 0;
            hash[2] = (hash[2] + c) >>> 0;
            hash[3] = (hash[3] + d) >>> 0;
            hash[4] = (hash[4] + e) >>> 0;
            hash[5] = (hash[5] + f) >>> 0;
            hash[6] = (hash[6] + g) >>> 0;
            hash[7] = (hash[7] + h) >>> 0;
        }

        return hash.map(
            value => value.toString(16).padStart(8, '0')
        ).join('');
    }

    function readVarint(bytes, start) {
        let value = 0;
        let shift = 0;
        let offset = start;

        while (offset < bytes.length && shift < 35) {
            const byte = bytes[offset];
            offset += 1;

            value |= (byte & 0x7f) << shift;

            if ((byte & 0x80) === 0) {
                return {
                    value: value >>> 0,
                    offset,
                };
            }

            shift += 7;
        }

        throw new Error('Некорректный protobuf-заголовок CRX.');
    }

    function findProtobufBytes(bytes, wantedField) {
        let offset = 0;

        while (offset < bytes.length) {
            const keyResult = readVarint(bytes, offset);

            offset = keyResult.offset;

            const fieldNumber = keyResult.value >>> 3;
            const wireType = keyResult.value & 0x07;

            if (wireType === 0) {
                offset = readVarint(bytes, offset).offset;

            } else if (wireType === 1) {
                offset += 8;

            } else if (wireType === 2) {
                const lengthResult = readVarint(bytes, offset);

                offset = lengthResult.offset;

                const end = offset + lengthResult.value;

                if (end > bytes.length) {
                    throw new Error('Повреждён protobuf-заголовок CRX.');
                }

                if (fieldNumber === wantedField) {
                    return bytes.subarray(offset, end);
                }

                offset = end;

            } else if (wireType === 5) {
                offset += 4;

            } else {
                throw new Error('Неизвестный тип поля CRX.');
            }

            if (offset > bytes.length) {
                throw new Error('Повреждён protobuf-заголовок CRX.');
            }
        }

        return null;
    }

    function extractCrxExtensionId(buffer) {
        const bytes = new Uint8Array(buffer);

        if (
            bytes.length < 12 ||
            String.fromCharCode(...bytes.subarray(0, 4)) !== 'Cr24'
        ) {
            throw new Error('Скачанный файл не является CRX.');
        }

        const view = new DataView(buffer);
        const crxVersion = view.getUint32(4, true);
        const headerSize = view.getUint32(8, true);

        if (crxVersion !== 3) {
            throw new Error('Ожидался формат CRX3.');
        }

        const headerEnd = 12 + headerSize;

        if (headerSize === 0 || headerEnd + 4 > bytes.length) {
            throw new Error('Заголовок CRX3 повреждён.');
        }

        if (
            bytes[headerEnd] !== 0x50 ||
            bytes[headerEnd + 1] !== 0x4b ||
            bytes[headerEnd + 2] !== 0x03 ||
            bytes[headerEnd + 3] !== 0x04
        ) {
            throw new Error('В CRX3 отсутствует ожидаемый ZIP-пакет.');
        }

        const signedHeaderData = findProtobufBytes(
            bytes.subarray(12, headerEnd),
            10000
        );

        if (!signedHeaderData) {
            throw new Error('В CRX3 отсутствует signed_header_data.');
        }

        const crxIdBytes = findProtobufBytes(signedHeaderData, 1);

        if (!crxIdBytes || crxIdBytes.length !== 16) {
            throw new Error('Не удалось прочитать Extension ID из CRX3.');
        }

        return Array.from(crxIdBytes, byte => {
            const high = byte >>> 4;
            const low = byte & 0x0f;

            return String.fromCharCode(
                97 + high,
                97 + low
            );
        }).join('');
    }

    function reportError(error, force) {
        const now = Date.now();
        const lastNotice = GM_getValue(STORAGE.lastErrorNoticeAt, 0);

        if (
            force ||
            now - lastNotice >= CONFIG.errorNoticeIntervalMs
        ) {
            GM_setValue(STORAGE.lastErrorNoticeAt, now);

            notify(
                'Ошибка обновления: ' +
                (
                    error && error.message
                        ? error.message
                        : String(error)
                )
            );
        }
    }

    function downloadVerifiedCrx(manifest, forceDownload = false) {
        if (isDownloading) return;

        const now = Date.now();
        const lastAttempt = GM_getValue(STORAGE.downloadAttemptAt, 0);

        if (
            !forceDownload &&
            now - lastAttempt < CONFIG.downloadRetryIntervalMs
        ) {
            return;
        }

        isDownloading = true;

        GM_setValue(STORAGE.downloadAttemptAt, now);

        notify(
            'Обнаружена версия ' +
            manifest.version +
            '. Скачиваю и проверяю CRX…'
        );

        const assetUrl =
            CONFIG.releaseDownloadBase +
            encodeURIComponent(manifest.crx) +
            '?cache_bust=' +
            Date.now();

        GM_xmlhttpRequest({
            method: 'GET',
            url: assetUrl,
            responseType: 'arraybuffer',

            headers: {
                'Accept': 'application/octet-stream',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },

            nocache: true,
            revalidate: true,
            timeout: CONFIG.downloadRequestTimeoutMs,

            onload(response) {
                (async () => {
                    try {
                        if (
                            response.status !== 200 ||
                            !(response.response instanceof ArrayBuffer)
                        ) {
                            throw new Error(
                                'Не удалось получить CRX (HTTP ' +
                                response.status +
                                ').'
                            );
                        }

                        const bytes = new Uint8Array(response.response);
                        const actualHash = await sha256Hex(bytes);

                        if (actualHash !== manifest.sha256) {
                            throw new Error(
                                'SHA-256 CRX не совпадает с JSON-манифестом. ' +
                                'Файл не будет сохранён.'
                            );
                        }

                        const actualExtensionId =
                            extractCrxExtensionId(response.response);

                        if (
                            actualExtensionId !== CONFIG.expectedExtensionId ||
                            actualExtensionId !== manifest.extension_id
                        ) {
                            throw new Error(
                                'Extension ID внутри CRX3 не совпадает ' +
                                'с ожидаемым. Файл не будет сохранён.'
                            );
                        }

                        const crxBlob = new Blob(
                            [response.response],
                            {
                                type: 'application/x-chrome-extension',
                            }
                        );

                        GM_download({
                            url: crxBlob,
                            name: manifest.crx,

                            onload() {
                                isDownloading = false;

                                GM_setValue(
                                    STORAGE.pendingVersion,
                                    manifest.version
                                );

                                GM_setValue(
                                    STORAGE.downloadAttemptAt,
                                    0
                                );

                                notify(
                                    'Версия ' +
                                    manifest.version +
                                    ' проверена и скачана. ' +
                                    'Проверь загрузки Chrome и установи обновление.'
                                );
                            },

                            onerror(error) {
                                isDownloading = false;

                                GM_setValue(
                                    STORAGE.downloadAttemptAt,
                                    0
                                );

                                const reason =
                                    error && error.error
                                        ? error.error
                                        : 'неизвестная ошибка';

                                reportError(
                                    new Error(
                                        'Tampermonkey не смог сохранить CRX: ' +
                                        reason
                                    ),
                                    true
                                );
                            },

                            ontimeout() {
                                isDownloading = false;

                                GM_setValue(
                                    STORAGE.downloadAttemptAt,
                                    0
                                );

                                reportError(
                                    new Error('Истекло время сохранения CRX.'),
                                    true
                                );
                            },
                        });

                    } catch (error) {
                        isDownloading = false;

                        GM_setValue(
                            STORAGE.downloadAttemptAt,
                            0
                        );

                        reportError(error, true);
                    }
                })();
            },

            onerror() {
                isDownloading = false;

                GM_setValue(
                    STORAGE.downloadAttemptAt,
                    0
                );

                reportError(
                    new Error('Не удалось скачать CRX с GitHub.'),
                    true
                );
            },

            ontimeout() {
                isDownloading = false;

                GM_setValue(
                    STORAGE.downloadAttemptAt,
                    0
                );

                reportError(
                    new Error('Истекло время ожидания загрузки CRX.'),
                    true
                );
            },

            onabort() {
                isDownloading = false;

                GM_setValue(
                    STORAGE.downloadAttemptAt,
                    0
                );

                reportError(
                    new Error('Загрузка CRX была прервана.'),
                    true
                );
            },
        });
    }

    function processManifest(
        manifest,
        force = false,
        forceDownload = false
    ) {
        const installedVersion = GM_getValue(
            STORAGE.installedVersion,
            ''
        );

        if (!installedVersion) {
            if (force) {
                notify(
                    'Сначала укажи установленную версию ' +
                    'через меню Tampermonkey.'
                );
            }

            return;
        }

        let comparison;

        try {
            comparison = compareVersions(
                manifest.version,
                installedVersion
            );

        } catch (error) {
            reportError(error, true);
            return;
        }

        const pendingVersion = GM_getValue(
            STORAGE.pendingVersion,
            ''
        );

        if (!forceDownload && comparison <= 0) {
            if (force) {
                notify(
                    'Обновлений нет. Установленная версия: ' +
                    normalizeVersion(installedVersion)
                );
            }

            return;
        }

        if (!forceDownload && pendingVersion === manifest.version) {
            if (force) {
                notify(
                    'Версия ' +
                    manifest.version +
                    ' уже скачана и ожидает установки.'
                );
            }

            return;
        }

        downloadVerifiedCrx(manifest, forceDownload);
    }

    function checkUpdates(force = false, forceDownload = false) {
        if (isChecking) return;

        const installedVersion = GM_getValue(
            STORAGE.installedVersion,
            ''
        );

        if (!installedVersion) {
            if (force) {
                notify(
                    'Сначала укажи установленную версию ' +
                    'через меню Tampermonkey.'
                );
            }

            return;
        }

        try {
            normalizeVersion(installedVersion);

        } catch (error) {
            if (force) {
                notify(
                    'Сохранённая версия некорректна. ' +
                    'Укажи её заново через меню Tampermonkey.'
                );
            }

            return;
        }

        const now = Date.now();

        const cachedManifest = GM_getValue(
            STORAGE.manifestCache,
            null
        );

        const checkedAt = GM_getValue(
            STORAGE.manifestCheckedAt,
            0
        );

        if (
            !force &&
            cachedManifest &&
            now - checkedAt < CONFIG.checkIntervalMs
        ) {
            try {
                processManifest(
                    validateManifest(cachedManifest),
                    false,
                    forceDownload
                );

                return;

            } catch (error) {
                // Повреждённый или устаревший кэш не используем —
                // запрашиваем манифест заново.
            }
        }

        const lastAttempt = GM_getValue(
            STORAGE.manifestAttemptAt,
            0
        );

        if (
            !force &&
            now - lastAttempt < CONFIG.requestRetryIntervalMs
        ) {
            return;
        }

        const lockUntil = GM_getValue(
            STORAGE.checkLockUntil,
            0
        );

        if (!force && lockUntil > now) {
            return;
        }

        isChecking = true;

        GM_setValue(
            STORAGE.checkLockUntil,
            now + CONFIG.lockDurationMs
        );

        GM_setValue(
            STORAGE.manifestAttemptAt,
            now
        );

        const finish = () => {
            isChecking = false;

            GM_setValue(
                STORAGE.checkLockUntil,
                0
            );
        };

        requestManifest(
            manifest => {
                GM_setValue(
                    STORAGE.manifestCache,
                    manifest
                );

                GM_setValue(
                    STORAGE.manifestCheckedAt,
                    Date.now()
                );

                finish();

                processManifest(
                    manifest,
                    force,
                    forceDownload
                );

                if (
                    force &&
                    compareVersions(manifest.version, installedVersion) <= 0 &&
                    !forceDownload
                ) {
                    // processManifest уже сообщил об отсутствии обновления.
                }
            },

            error => {
                finish();
                reportError(error, force);
            }
        );
    }

    function setInstalledVersion() {
        const current = GM_getValue(
            STORAGE.installedVersion,
            ''
        );

        const entered = prompt(
            'Введи текущую версию uBlock Origin.\n' +
            'Посмотреть её можно в chrome://extensions\n\n' +
            'Например: 1.77.2',
            current || ''
        );

        if (entered === null) return;

        let version;

        try {
            version = normalizeVersion(entered);

        } catch (error) {
            notify(
                'Неправильный формат версии. Пример: 1.77.2'
            );

            return;
        }

        GM_setValue(
            STORAGE.installedVersion,
            version
        );

        GM_setValue(
            STORAGE.pendingVersion,
            ''
        );

        notify(
            'Текущая версия установлена: ' +
            version
        );

        checkUpdates(true);
    }

    function confirmInstalledVersion() {
        const pending = GM_getValue(
            STORAGE.pendingVersion,
            ''
        );

        if (!pending) {
            notify('Нет ожидающего обновления.');
            return;
        }

        if (
            confirm(
                'Ты действительно установил uBlock Origin ' +
                pending +
                '?'
            )
        ) {
            GM_setValue(
                STORAGE.installedVersion,
                pending
            );

            GM_setValue(
                STORAGE.pendingVersion,
                ''
            );

            notify(
                'Установленная версия обновлена: ' +
                pending
            );
        }
    }

    // Сохраняем команды и ключи хранения версии 1.0.
    GM_registerMenuCommand(
        'uBO: Указать установленную версию',
        setInstalledVersion
    );

    GM_registerMenuCommand(
        'uBO: Проверить обновление сейчас',
        () => checkUpdates(true)
    );

    GM_registerMenuCommand(
        'uBO: Скачать последнюю версию повторно',
        () => checkUpdates(true, true)
    );

    GM_registerMenuCommand(
        'uBO: Подтвердить установку загруженной версии',
        confirmInstalledVersion
    );

    // При отсутствии установленной версии не показываем уведомление на каждой странице.
    // Пользователь может задать её через меню Tampermonkey.
    checkUpdates(false);

    // Сохраняем привычное поведение версии 1.0: обновлятор повторно активируется
    // во время работы браузера, но сетевой запрос к JSON выполняется не чаще 1 раза в 6 часов.
    window.setInterval(
        () => checkUpdates(false),
        CONFIG.repeatedCheckIntervalMs
    );

})();
