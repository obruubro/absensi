const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let waClient;
let isReady = false;
let latestQR = null;
const messageQueue = [];
let isProcessingQueue = false;

// Menyimpan status percakapan orang tua yang sedang ditanya alasannya
const pendingReason = new Map();

function initWhatsApp(io, db) {
    waClient = new Client({
        authStrategy: new LocalAuth({ clientId: 'admin-absensi' }),
        puppeteer: {
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    waClient.on('qr', (qr) => {
        latestQR = qr;
        console.log('Scan QR WhatsApp Admin di bawah ini:');
        qrcode.generate(qr, { small: true });
        io.emit('wa_qr', qr);
    });

    waClient.on('ready', () => {
        isReady = true;
        latestQR = null;
        console.log('✅ WhatsApp Admin SMKN Kasomalang Terhubung!');
        io.emit('wa_status', { connected: true });
    });

    waClient.on('disconnected', () => {
        isReady = false;
        io.emit('wa_status', { connected: false });
    });

    waClient.on('message', async (msg) => {
        // Abaikan pesan dari grup atau status
        if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;

        const sender = msg.from.replace('@c.us', '');
        const text = msg.body.trim();
        const today = new Date().toISOString().split('T')[0];

        const infoWaliTeks = `\n\nAbsen sudah dicatat, harap selanjutnya informasikan ke wali kelas.`;

        try {
            // Cek apakah nomor pengirim terdaftar sebagai orang tua siswa yang hari ini berstatus 'Alpa' (belum konfirmasi)
            const [siswaAlpaRows] = await db.query(`
                SELECT s.id, s.nama_siswa, k.nama_kelas 
                FROM siswa s
                JOIN kelas k ON s.kelas_id = k.id
                JOIN absensi a ON s.id = a.siswa_id
                WHERE s.no_wa_ortu = ? AND a.tanggal = ? AND a.status = 'Alpa'
            `, [sender, today]);

            // Jika bukan nomor orang tua siswa yang belum hadir hari ini, abaikan saja
            if (siswaAlpaRows.length === 0) return;

            const matchKeyword = text.match(/^(sakit|izin|ijin|tanpa keterangan|alpa|alpha)(?:\s+(.*))?$/i);

            // TAHAP 2: Orang tua menuliskan alasan setelah ditanya bot
            if (pendingReason.has(sender) && !matchKeyword) {
                const statusBaru = pendingReason.get(sender);
                pendingReason.delete(sender);

                for (const siswa of siswaAlpaRows) {
                    await db.query(
                        `UPDATE absensi SET status = ?, keterangan = ? 
                         WHERE siswa_id = ? AND tanggal = ? AND status = 'Alpa'`,
                        [statusBaru, text, siswa.id, today]
                    );

                    await msg.reply(
                        `✅ Terima kasih Bapak/Ibu. Keterangan *${statusBaru}* untuk ananda *${siswa.nama_siswa}* (${siswa.nama_kelas}) telah diterima.\nAlasan: _${text}_${infoWaliTeks}`
                    );
                }
                io.emit('refresh_dashboard');
                return;
            }

            // TAHAP 1: Orang tua membalas kata kunci (Sakit / Izin / Tanpa Keterangan)
            if (matchKeyword) {
                const kataKunci = matchKeyword[1].toLowerCase();
                const alasanLangsung = (matchKeyword[2] || '').trim();

                if (kataKunci === 'sakit') {
                    if (alasanLangsung) {
                        pendingReason.delete(sender);
                        for (const siswa of siswaAlpaRows) {
                            await db.query(
                                `UPDATE absensi SET status = 'Sakit', keterangan = ? WHERE siswa_id = ? AND tanggal = ? AND status = 'Alpa'`,
                                [alasanLangsung, siswa.id, today]
                            );
                            await msg.reply(
                                `✅ Terima kasih Bapak/Ibu. Keterangan *Sakit* untuk ananda *${siswa.nama_siswa}* (${siswa.nama_kelas}) telah diterima (_${alasanLangsung}_).${infoWaliTeks}`
                            );
                        }
                        io.emit('refresh_dashboard');
                    } else {
                        pendingReason.set(sender, 'Sakit');
                        await msg.reply(
                            `Baik Bapak/Ibu, ananda tercatat *SAKIT*.\n\nSilakan balas pesan ini dengan menuliskan *sakit apa* yang dialami ananda (Contoh: _Demam dan batuk_).`
                        );
                    }
                } else if (kataKunci === 'izin' || kataKunci === 'ijin') {
                    if (alasanLangsung) {
                        pendingReason.delete(sender);
                        for (const siswa of siswaAlpaRows) {
                            await db.query(
                                `UPDATE absensi SET status = 'Izin', keterangan = ? WHERE siswa_id = ? AND tanggal = ? AND status = 'Alpa'`,
                                [alasanLangsung, siswa.id, today]
                            );
                            await msg.reply(
                                `✅ Terima kasih Bapak/Ibu. Keterangan *Izin* untuk ananda *${siswa.nama_siswa}* (${siswa.nama_kelas}) telah diterima (_${alasanLangsung}_).${infoWaliTeks}`
                            );
                        }
                        io.emit('refresh_dashboard');
                    } else {
                        pendingReason.set(sender, 'Izin');
                        await msg.reply(
                            `Baik Bapak/Ibu, ananda tercatat *IZIN*.\n\nSilakan balas pesan ini dengan menuliskan *alasan izinnya* (Contoh: _Ada acara keluarga_).`
                        );
                    }
                } else {
                    // Tanpa Keterangan / Alpa
                    pendingReason.delete(sender);
                    for (const siswa of siswaAlpaRows) {
                        await db.query(
                            `UPDATE absensi SET status = 'Alpa', keterangan = 'Dikonfirmasi orang tua (Tanpa Keterangan)' 
                             WHERE siswa_id = ? AND tanggal = ? AND status = 'Alpa'`,
                            [siswa.id, today]
                        );
                        await msg.reply(
                            `Baik Bapak/Ibu, informasi untuk ananda *${siswa.nama_siswa}* (${siswa.nama_kelas}) tercatat sebagai *Tanpa Keterangan (Alpa)*.${infoWaliTeks}`
                        );
                    }
                    io.emit('refresh_dashboard');
                }
                return;
            }

            // TAHAP 0 (SALAH FORMAT): Pesan tidak diawali Sakit / Izin / Tanpa Keterangan
            const daftarNama = siswaAlpaRows.map(s => `*${s.nama_siswa}* (${s.nama_kelas})`).join(', ');
            await msg.reply(
                `Maaf Bapak/Ibu, format balasan belum sesuai sehingga belum dapat dicatat sistem.\n\nUntuk konfirmasi ketidakhadiran ananda ${daftarNama}, silakan balas cukup dengan mengetik salah satu kata berikut:\n\n• *Sakit*\n• *Izin*\n• *Tanpa Keterangan*`
            );

        } catch (err) {
            console.error('Gagal memproses balasan WA:', err);
        }
    });

    waClient.initialize();
}

function queueMessage(phone, message) {
    let formatted = phone.replace(/\D/g, '');
    if (formatted.startsWith('0')) formatted = '62' + formatted.slice(1);
    const chatId = `${formatted}@c.us`;

    messageQueue.push({ chatId, message });
    processQueue();
}

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0 || !isReady) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const item = messageQueue.shift();
        try {
            await waClient.sendMessage(item.chatId, item.message);
        } catch (err) {
            console.error(`Gagal kirim WA ke ${item.chatId}:`, err.message);
        }
        await new Promise((res) => setTimeout(res, 2500));
    }
    isProcessingQueue = false;
}

module.exports = { initWhatsApp, queueMessage, getWaInfo: () => ({ isReady, latestQR }) };