/* ==========================================================================
   QR tickets — drawing. Needs vendor/qrcode.min.js loaded first.

   drawTicketQR(canvas, code, { logo, size }) draws one ticket's QR code with
   the school crest in the middle. The code uses the highest error correction
   (H, which survives about 30% of it being covered); the crest covers well
   under that, so every code still scans.
   ========================================================================== */

/** Load an image once and share it between every ticket on the page. */
const qrLogoCache = {};
function loadQRLogo(src) {
    if (!src) return Promise.resolve(null);
    return qrLogoCache[src] ||= new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);      // no crest is fine: the code still works
        img.src = src;
    });
}

function drawTicketQR(canvas, code, { logo = null, size = 320 } = {}) {
    const qr = qrcode(0, 'H');
    qr.addData(code);
    qr.make();

    const count = qr.getModuleCount();
    const quiet = 4;                                   // the white border scanners need
    const cell = Math.max(2, Math.floor(size / (count + quiet * 2)));
    const px = cell * (count + quiet * 2);

    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#14273a';
    for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
        }
    }

    if (logo) {
        // A white rounded plate under a third of the code across (about 9% of its area), with the
        // crest on it. Kept small so error correction covers it easily.
        const plate = Math.round(count * cell * 0.3);
        const x = Math.round((px - plate) / 2);
        const radius = Math.round(plate * 0.18);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(x + radius, x);
        ctx.arcTo(x + plate, x, x + plate, x + plate, radius);
        ctx.arcTo(x + plate, x + plate, x, x + plate, radius);
        ctx.arcTo(x, x + plate, x, x, radius);
        ctx.arcTo(x, x, x + plate, x, radius);
        ctx.closePath();
        ctx.fill();
        const pad = Math.round(plate * 0.08);
        ctx.drawImage(logo, x + pad, x + pad, plate - pad * 2, plate - pad * 2);
    }
    return canvas;
}
