/*
 * A Tampermonkey script to enhance Radarr's interactive search by adding a
 * subtitle column that indicates the availability of subtitles in various
 * languages.
 *
 * Icons shown in the subtitle column:
 * 🇸🇪 Indicates the supported languages.
 * ◌  Loading tracker page.
 * ⛔ The site is not allowed to be accessed. Allow the site using the @match
 *    and @connect keywords in the userscript header to allow access.
 * 💤 Timeout. The site did not respond in time.
 * ❌ No configured subtitles were found.
 *
 * Known quirks:
 * - May not work on all torrent sites due to X-Frame-Options restrictions.
 *   A possible workaround is to use a browser plugin that disables X-Frame-Options.
 *
 * Known bugs:
 * - Doesn't always work when filtering.
 *
 * Dependencies:
 * - Tampermonkey or similar userscript manager.
 *
 * How it works:
 * The script is injected into Radarr and specified torrent sites using
 * Tampermonkey.
 *
 * When the user clicks the "Interactive Search" button in Radarr, the script
 * adds a "Subtitle" column to the results table. For each torrent listed, when
 * the row becomes visible on the screen, the script fetches the torrent page
 * and searches for the language keywords indicating the availability of
 * subtitles in various languages.
 *
 * If possible, the script first tries to fetch the page using a GET request.
 * If it doesn't find any subtitles, it tries to load the page in a hidden
 * iframe instead. This will load the whole page, including any dynamically
 * loaded content, which the GET request might miss.
 *
 * The site loaded in the iframe gets injected with the script which searches
 * for subtitles and sends a message back (with flags) to the Radarr page's
 * script instance.
 *
 * The script uses a work queue to limit the number of concurrent requests to
 * avoid overloading the browser or the torrent sites.
 */

// ==UserScript==
// @name         RadarrSubMonkey
// @namespace    https://github.com/robsel-0/RadarrSubMonkey
// @version      2026-01-08
// @description  Try to take over the world!
// @author       robsel-0
// @icon         https://raw.githubusercontent.com/robsel-0/RadarrSubMonkey/refs/heads/master/icon64x64.png
// @grant        GM_xmlhttpRequest
// @grant        window.onurlchange
// @match        http://radarr.intra/*
//
// @match        https://thepiratebay.org/*
// @connect      thepiratebay.org
//
// @match        www.torrentleech.org/*
// @connect      www.torrentleech.org
//
// @match        uindex.org/*
// @connect      uindex.org
// ==/UserScript==

(function () {
    'use strict';

    const nQueueWorkers = 5;
    const pageLoadTimeoutMs = 5000;
    const waitBetweenFetchRequestsMs = 1000;

    const languageFlags = {
        swedish: '🇸🇪',
        norwegian: '🇳🇴',
        finnish: '🇫🇮',
        danish: '🇩🇰',
        icelandic: '🇮🇸',
        english: '🇬🇧',
        german: '🇩🇪',
        french: '🇫🇷',
    };

    const matchDomains = getMatchDomains();
    const connectDomains = getConnectDomains();
    const radarrUrl = getRadarrUrl();

    ////////////////////////////////////////////////////////////////////////////

    class WorkQueue {
        #nWorkers = 0;
        #queue = [];
        #activeCount = 0;

        constructor(nWorkers) {
            this.#nWorkers = nWorkers;
        }

        addWork(urlString, setStatus) {
            this.#queue.push({ urlString: urlString, setStatus });
            this.#processQueue();
        }

        #processQueue() {
            while (this.#activeCount < this.#nWorkers && this.#queue.length > 0) {
                const item = this.#queue.shift();
                this.#activeCount++;

                fetchLinkAndSearchForSubtitles(item.urlString, item.setStatus, () => {
                    this.#activeCount--;
                    this.#processQueue();
                });
            }
        }
    }

    const workQueue = new WorkQueue(nQueueWorkers);

    ////////////////////////////////////////////////////////////////////////////

    function log(...args) {
        console.log('[RadarrSubMonkey]', ...args);
    }

    ////////////////////////////////////////////////////////////////////////////

    function getRadarrUrl() {
        for (const match of GM_info.script.matches) {
            for (const connect of GM_info.script.connects) {
                if (!match.includes(connect)) {
                    return match.replace('*', '');
                }
            }
        }
    }

    function getConnectDomains() {
        const domains = [];
        for (const str of GM_info.script.connects) {
            const url = str.includes('://') ? str : 'http://' + str;
            domains.push((new URL(url)).hostname);
        }
        return domains;
    }

    function getMatchDomains() {
        const domains = [];
        for (const str of GM_info.script.matches) {
            const url = (str.includes('://') ? str : 'http://' + str).replace('*', 'example');
            domains.push((new URL(url)).hostname);
        }
        return domains;
    }

    ////////////////////////////////////////////////////////////////////////////

    function findAndCall(root = document, searchFunction, foundFunction) {
        const targetNode = root instanceof Document ? (root.body || root.documentElement) : root;

        const attachIfFound = () => {
            const elem = searchFunction(targetNode);
            if (elem && !elem.__interactiveSearchListenerAttached) {
                elem.__interactiveSearchListenerAttached = true;
                foundFunction(elem);
                return true;
            }
            return false;
        };

        // Try immediately
        if (!attachIfFound()) {
            const observer = new MutationObserver(() => {
                if (attachIfFound()) {
                    observer.disconnect();
                }
            });
            observer.observe(targetNode, { childList: true, subtree: true });
        }
    }

    ////////////////////////////////////////////////////////////////////////////

    function findInteractiveSearchButton(root = document) {
        const divs = root.getElementsByTagName('div');
        for (let i = 0; i < divs.length; i++) {
            const el = divs[i];
            const text = el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
            if (text === 'Interactive Search') {
                const btn = el.closest('button');
                if (btn) return btn;
            }
        }
        return null;
    }

    function attachListenerToInteractiveSearchButton(listener, root = document) {
        findAndCall(root, findInteractiveSearchButton, (btn) => {
            log("Adding listener to Interactive Search button:", btn);
            btn.addEventListener('click', listener);
        });
    }

    function onInteractiveSearchButtonPressed(btn) {
        log('Interactive Search button clicked');

        const node = document.body || document.documentElement;
        findAndCall(node, findModalHeaderDiv, whenModalHeaderDivFound);
    }

    ////////////////////////////////////////////////////////////////////////////

    function findModalHeaderDiv(root) {
        const divs = root.getElementsByTagName('div');
        if (!divs) {
            return null;
        }

        for (let i = 0; i < divs.length; i++) {
            const el = divs[i];
            for (const cls of el.classList) {
                if (cls.startsWith('ModalHeader-modalHeader-')) {
                    return el;
                }
            }
        }

        return null;
    }

    function whenModalHeaderDivFound(modalHeaderDiv) {
        const modalContent = searchUpwardsForModalContent(modalHeaderDiv);
        findAndCall(modalContent, findResultsTable, whenResultsTableFound);
    }

    ////////////////////////////////////////////////////////////////////////////

    function searchUpwardsForModalContent(startNode) {
        let current = startNode;
        while (current) {
            if (current.tagName === 'DIV') {
                for (const cls of current.classList) {
                    if (cls.startsWith('ModalContent-modalContent-')) {
                        return current;
                    }
                }
            }
            current = current.parentElement;
        }
        return null;
    }

    ////////////////////////////////////////////////////////////////////////////

    function findResultsTable(root) {
        const tables = root.getElementsByTagName('table');
        for (let i = 0; i < tables.length; i++) {
            const el = tables[i];
            for (const cls of el.classList) {
                if (cls.startsWith('Table-table-')) {
                    return el;
                }
            }
        }
        return null;
    }

    function whenResultsTableFound(table) {
        findAndCall(table, findThead, addSubtitleHeading);
        findAndCall(table, findTbody, whenTbodyFound);
    }

    ////////////////////////////////////////////////////////////////////////////

    function findThead(root) {
        const theads = root.getElementsByTagName('thead');
        if (theads.length > 0) {
            return theads[0];
        }

        return null;
    }

    function addSubtitleHeading(thead) {
        const all_trs_in_thead = thead.querySelectorAll('tr');
        for (const tr of all_trs_in_thead) {
            const th = findLanguageThInThead(tr);
            const newTh = document.createElement('th');
            newTh.className = th.className;
            newTh.textContent = 'Subtitle';
            th.parentNode.insertBefore(newTh, th.nextSibling);
        }
    }

    function findLanguageThInThead(tr) {
        const ths = tr.getElementsByTagName('th');
        for (let i = 0; i < ths.length; i++) {
            const th = ths[i];
            if (th.textContent.trim().toLowerCase() === 'language') {
                return th;
            }
        }

        return null;
    }

    ////////////////////////////////////////////////////////////////////////////

    function findTbody(root) {
        const tbodies = root.getElementsByTagName('tbody');
        if (tbodies.length > 0) {
            return tbodies[0];
        }

        return null;
    }

    function whenTbodyFound(tbody) {
        insertLanguageColumnInAllRows(tbody);
        addObserverToAllRows(tbody, whenTrIsVisibleOnScreen);
    }

    function whenTrIsVisibleOnScreen(tr, observer) {
        const td = getSubtitleTdInTableRow(tr);

        const span = document.createElement('span');
        td.appendChild(span);
        const setStatus = (text) => { span.textContent = text; };

        const link = getLinkInTrAsString(tr);
        if (isAllowedHostname((new URL(link)).hostname)) {
            setStatus('◌');
            workQueue.addWork(link, setStatus);
        } else {
            setStatus('⛔');
        }

        observer.unobserve(tr);
    };

    function insertLanguageColumnInAllRows(tbody) {
        const all_trs_in_tbody = tbody.querySelectorAll('tr');
        for (const tr of all_trs_in_tbody) {
            insertSubtitleColumn(tr);
        }
    }

    function addObserverToAllRows(tbody, whenTrIsVisibleOnScreen = (tr, observer) => { }) {
        const options = {
            root: null, // viewport
            rootMargin: '0px',
            threshold: 0.5 // 50% visibility required for callback to be triggered
        };

        const observerCallback = (entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    if (entry.target.tagName === 'TR') {
                        const tr = entry.target;
                        whenTrIsVisibleOnScreen(tr, observer);
                    }
                }
            });
        };

        const observer = new IntersectionObserver(observerCallback, options);

        const all_trs_in_tbody = tbody.querySelectorAll('tr');
        for (const tr of all_trs_in_tbody) {
            observer.observe(tr);
        }
    }

    function insertSubtitleColumn(tr) {
        const td = getLanguageTdInTableRow(tr);

        const newTd = document.createElement('td');
        newTd.className = td.className + " subtitles";
        td.parentNode.insertBefore(newTd, td.nextSibling);

        return newTd;
    }

    function getLinkInTrAsString(tr) {
        const anchors = tr.getElementsByTagName('a');
        for (let i = 0; i < anchors.length; i++) {
            const el = anchors[i];
            for (const cls of el.classList) {
                if (cls.startsWith('Link-link-')) {
                    return el.href;
                }
            }
        }
        return null;
    }

    function getLanguageTdInTableRow(tr) {
        const tds = tr.getElementsByTagName('td');
        for (let i = 0; i < tds.length; i++) {
            const td = tds[i];
            for (const cls of td.classList) {
                if (cls.startsWith('InteractiveSearchRow-languages-')) {
                    return td;
                }
            }
        }

        return null;
    }

    function getSubtitleTdInTableRow(tr) {
        const tds = tr.getElementsByTagName('td');
        for (let i = 0; i < tds.length; i++) {
            const td = tds[i];
            for (const cls of td.classList) {
                if (cls.startsWith('subtitles')) {
                    return td;
                }
            }
        }

        return null;
    }

    function isAllowedHostname(hostname) {
        return matchDomains.includes(hostname) && connectDomains.includes(hostname);
    }

    ////////////////////////////////////////////////////////////////////////////

    function fetchLinkAndSearchForSubtitles(urlString, setStatus = (str) => { }, onDone = () => { }) {
        // First try using GET. If that fails to find subtitles, try using iframe.
        let status = '';

        const createDelayedCallback = (fn) => {
            const delayedOnDone = () => {
                setTimeout(() => {
                    fn();
                }, waitBetweenFetchRequestsMs);
            };

            return delayedOnDone;
        }

        const saveStatus = (str) => {
            status = str;
        }

        const onDoneUsingGet = () => {
            if (status === '❌') {
                fetchLinkAndSearchForSubtitlesUsingIframe(urlString,
                    setStatus,
                    createDelayedCallback(onDone));
            } else {
                setStatus(status);
                onDone();
            }
        };

        fetchLinkAndSearchForSubtitlesUsingGet(urlString,
            saveStatus,
            createDelayedCallback(onDoneUsingGet));
    }

    function fetchLinkAndSearchForSubtitlesUsingIframe(urlString, setStatus = (str) => { }, onDone = () => { }) {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.width = '500';
        iframe.height = '500';
        iframe.src = urlString;
        document.body.prepend(iframe);

        const cleanup = () => {
            clearTimeout(timeoutId);
            window.removeEventListener('message', eventListener);
            iframe.remove();
            onDone();
        };

        const eventListener = event => {
            if (event.source !== iframe.contentWindow) {
                log('Message received from unknown source, in radarr site. Ignoring. Source:', event.source);
                return;
            }

            log('Message received in radarr site:', event.data);

            try {
                const data = JSON.parse(event.data);

                if (!data.url) {
                    log('Message data does not contain url, ignoring:', data);
                    return;
                }

                if (data.url !== urlString) {
                    log('Message url does not match requested link, ignoring. Message url:', data.url, 'Requested link:', urlString);
                    return;
                }

                setStatus(data.flags);
            } catch (e) {
                log('Error parsing message data:', e);
                return;
            }

            cleanup();
        }

        const timeoutId = setTimeout(() => {
            log('Timeout waiting for message from iframe for link:', urlString);
            cleanup();
            setStatus('💤');
        }, pageLoadTimeoutMs);

        window.addEventListener('message', eventListener);
    }

    function fetchLinkAndSearchForSubtitlesUsingGet(urlString, setText = (text) => { }, onDone = () => { }) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: urlString,
            onload: (res) => {
                if (res.status < 200 || res.status >= 300) {
                    log("Invalid return status: " + new Error(`HTTP ${res.status}`));
                    setText('HTTP ' + res.status);
                    onDone();
                    return;
                }

                const content = res.responseText;
                if (typeof content !== 'string') {
                    setText('❓');
                    onDone();
                    return;
                }

                var flags = parseContentForLanguageFlags(content);
                setText(flags || '❌');
                onDone();
            },
            onerror: (err) => {
                err = err && err.error ? new Error(err.error) : new Error('GM_xmlhttpRequest failed');
                log(err);
                setText('⛔');
                onDone();
            },
            ontimeout: () => {
                log("Timeout: " + new Error('GM_xmlhttpRequest timeout'));
                setText('💤');
                onDone();
            }
        });
    }

    function parseContentForLanguageFlags(content) {
        const lowerCaseContent = content.toLowerCase();
        var flags = '';

        for (const [lang, flag] of Object.entries(languageFlags)) {
            if (lowerCaseContent.includes(lang)) {
                flags += flag;
            }
        }

        return flags;
    }

    ////////////////////////////////////////////////////////////////////////////

    function mainRadarr() {
        log("LOADED on Radarr site: ", window.location.href);
        attachListenerToInteractiveSearchButton(onInteractiveSearchButtonPressed);

        window.addEventListener("urlchange", () => {
            log("RELOADED on Radarr site due to URL change: ", window.location.href);
            attachListenerToInteractiveSearchButton(onInteractiveSearchButtonPressed);
        });
    }

    ////////////////////////////////////////////////////////////////////////////

    function mainOther() {
        log("LOADED on other site: ", window.location.href);

        const content = document.body ? document.body.textContent : '';
        var flags = parseContentForLanguageFlags(content);
        flags = flags || '❌';

        const payload = { url: window.location.href, flags };
        log('Sending message to parent:', payload);
        window.parent.postMessage(JSON.stringify(payload), radarrUrl);
    }

    ////////////////////////////////////////////////////////////////////////////

    function main() {
        if (window.location.href.includes(radarrUrl)) {
            mainRadarr();
        } else {
            mainOther();
        }
    }

    main();
})();
