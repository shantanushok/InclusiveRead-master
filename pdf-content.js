// PDF Content Script - Extracts text from PDFs and creates an accessible HTML view
// Uses Mozilla's pdf.js library to parse PDF documents

(function () {
    'use strict';

    // Avoid double-initialization
    if (window.__inclusiveReadPdfLoaded) return;
    window.__inclusiveReadPdfLoaded = true;

    const PDF_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.mjs';
    const PDF_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.mjs';

    /**
     * Check if current page is a PDF
     */
    function isPdfPage() {
        const url = window.location.href;
        // Chrome's built-in PDF viewer or direct .pdf URL
        if (url.toLowerCase().endsWith('.pdf')) return true;
        // Check content type from embed element (Chrome PDF viewer)
        const embed = document.querySelector('embed[type="application/pdf"]');
        if (embed) return true;
        // Check for PDF MIME in the document
        if (document.contentType === 'application/pdf') return true;
        return false;
    }

    if (!isPdfPage()) return;

    console.log('InclusiveRead: PDF detected, initializing PDF reader...');

    // State
    let pdfDoc = null;
    let totalPages = 0;
    let extractedText = '';
    let pdfViewerContainer = null;

    /**
     * Load pdf.js dynamically
     */
    async function loadPdfJs() {
        if (window.pdfjsLib) return window.pdfjsLib;

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.js';
            script.onload = () => {
                const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
                if (pdfjsLib) {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_CDN;
                    resolve(pdfjsLib);
                } else {
                    reject(new Error('pdf.js loaded but pdfjsLib not found'));
                }
            };
            script.onerror = () => reject(new Error('Failed to load pdf.js'));
            document.head.appendChild(script);
        });
    }

    /**
     * Extract text from all pages of the PDF
     */
    async function extractPdfText(pdfjsLib, url) {
        const loadingTask = pdfjsLib.getDocument(url);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        const pages = [];

        for (let i = 1; i <= totalPages; i++) {
            const page = await pdfDoc.getPage(i);
            const textContent = await page.getTextContent();

            let pageText = '';
            let lastY = null;

            for (const item of textContent.items) {
                if (item.str === undefined) continue;

                // Detect line breaks based on Y position changes
                if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) {
                    pageText += '\n';
                }
                pageText += item.str;
                lastY = item.transform[5];
            }

            pages.push({
                pageNum: i,
                text: pageText.trim()
            });
        }

        return pages;
    }

    /**
     * Create the accessible HTML view from extracted PDF text
     */
    function createAccessibleView(pages) {
        // Hide the original PDF embed
        const originalContent = document.body.children;
        for (let i = 0; i < originalContent.length; i++) {
            if (originalContent[i].id !== 'ir-pdf-viewer') {
                originalContent[i].style.display = 'none';
            }
        }

        // Create the viewer container
        pdfViewerContainer = document.createElement('div');
        pdfViewerContainer.id = 'ir-pdf-viewer';

        // Create header bar
        const header = document.createElement('div');
        header.className = 'ir-pdf-header';
        header.innerHTML = `
            <div class="ir-pdf-header-left">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                </svg>
                <span class="ir-pdf-title">InclusiveRead PDF Viewer</span>
                <span class="ir-pdf-badge">${totalPages} page${totalPages !== 1 ? 's' : ''}</span>
            </div>
            <div class="ir-pdf-header-right">
                <button class="ir-pdf-toggle-btn" id="ir-pdf-toggle-view" title="Switch back to original PDF viewer">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                    <span>Original PDF</span>
                </button>
            </div>
        `;

        pdfViewerContainer.appendChild(header);

        // Create content area
        const content = document.createElement('div');
        content.className = 'ir-pdf-content';

        for (const page of pages) {
            const pageDiv = document.createElement('div');
            pageDiv.className = 'ir-pdf-page';
            pageDiv.setAttribute('data-page', page.pageNum);

            const pageHeader = document.createElement('div');
            pageHeader.className = 'ir-pdf-page-header';
            pageHeader.textContent = `Page ${page.pageNum} of ${totalPages}`;
            pageDiv.appendChild(pageHeader);

            const pageBody = document.createElement('div');
            pageBody.className = 'ir-pdf-page-body';

            // Convert text to paragraphs
            const paragraphs = page.text.split(/\n\s*\n/);
            for (const para of paragraphs) {
                const trimmed = para.trim();
                if (!trimmed) continue;

                const p = document.createElement('p');
                p.className = 'ir-pdf-paragraph';
                p.textContent = trimmed;
                pageBody.appendChild(p);
            }

            if (!page.text.trim()) {
                const empty = document.createElement('p');
                empty.className = 'ir-pdf-empty';
                empty.textContent = '(This page contains no extractable text — it may be an image or scanned document)';
                pageBody.appendChild(empty);
            }

            pageDiv.appendChild(pageBody);
            content.appendChild(pageDiv);
        }

        pdfViewerContainer.appendChild(content);
        document.body.appendChild(pdfViewerContainer);

        // Store full extracted text for features like jargon decoder
        extractedText = pages.map(p => p.text).join('\n\n');

        // Toggle button handler
        document.getElementById('ir-pdf-toggle-view').addEventListener('click', toggleOriginalView);
    }

    /**
     * Toggle between accessible view and original PDF
     */
    let showingOriginal = false;
    function toggleOriginalView() {
        showingOriginal = !showingOriginal;
        const btn = document.getElementById('ir-pdf-toggle-view');

        if (showingOriginal) {
            // Show original PDF
            pdfViewerContainer.style.display = 'none';
            const originalContent = document.body.children;
            for (let i = 0; i < originalContent.length; i++) {
                if (originalContent[i].id !== 'ir-pdf-viewer') {
                    originalContent[i].style.display = '';
                }
            }
            btn.querySelector('span').textContent = 'Accessible View';
        } else {
            // Show accessible view
            pdfViewerContainer.style.display = '';
            const originalContent = document.body.children;
            for (let i = 0; i < originalContent.length; i++) {
                if (originalContent[i].id !== 'ir-pdf-viewer') {
                    originalContent[i].style.display = 'none';
                }
            }
            btn.querySelector('span').textContent = 'Original PDF';
        }
    }

    /**
     * Show loading screen
     */
    function showLoadingScreen() {
        const loader = document.createElement('div');
        loader.id = 'ir-pdf-loader';
        loader.innerHTML = `
            <div class="ir-pdf-loader-content">
                <div class="ir-pdf-spinner"></div>
                <h2>InclusiveRead</h2>
                <p id="ir-pdf-loader-status">Loading PDF document...</p>
            </div>
        `;
        document.body.appendChild(loader);
    }

    function updateLoadingStatus(text) {
        const status = document.getElementById('ir-pdf-loader-status');
        if (status) status.textContent = text;
    }

    function hideLoadingScreen() {
        const loader = document.getElementById('ir-pdf-loader');
        if (loader) loader.remove();
    }

    /**
     * Show error message
     */
    function showError(message) {
        hideLoadingScreen();
        const errorDiv = document.createElement('div');
        errorDiv.id = 'ir-pdf-error';
        errorDiv.innerHTML = `
            <div class="ir-pdf-error-content">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="48" height="48">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <h2>Could not read PDF</h2>
                <p>${message}</p>
                <p class="ir-pdf-error-hint">The original PDF viewer is still available.</p>
            </div>
        `;
        document.body.appendChild(errorDiv);
    }

    /**
     * Inject PDF viewer styles
     */
    function injectPdfStyles() {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('pdf-content.css');
        document.head.appendChild(link);
    }

    /**
     * Main initialization
     */
    async function initPdfReader() {
        injectPdfStyles();
        showLoadingScreen();

        try {
            updateLoadingStatus('Loading PDF parser...');
            const pdfjsLib = await loadPdfJs();

            updateLoadingStatus('Extracting text from PDF...');
            const pdfUrl = window.location.href;
            const pages = await extractPdfText(pdfjsLib, pdfUrl);

            updateLoadingStatus('Building accessible view...');
            createAccessibleView(pages);

            hideLoadingScreen();
            console.log(`InclusiveRead: PDF processed — ${totalPages} pages, ${extractedText.length} characters extracted`);
        } catch (error) {
            console.error('InclusiveRead PDF Error:', error);
            showError('Failed to extract text from this PDF. It may be encrypted, corrupted, or a scanned image.');
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPdfReader);
    } else {
        initPdfReader();
    }
})();
