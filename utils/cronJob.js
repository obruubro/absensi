const cron = require('node-cron');
const { queueMessage } = require('./whatsapp');

let activeTask = null;

async function startOrReloadCron(db, io) {
    if (activeTask) {
        activeTask.stop();
        activeTask = null;
    }

    try {
        const [[config]] = await db.query(`
            SELECT id, nama_sekolah, alamat_sekolah, 
                   TO_CHAR(jam_batas_hadir, 'HH24:MI:SS') AS jam_batas_hadir,
                   TO_CHAR(jam_cek_alpa, 'HH24:MI:SS') AS jam_cek_alpa,
                   hari_aktif
            FROM pengaturan WHERE id = 1
        `);
        if (!config) return;

        const [hour, minute] = config.jam_cek_alpa.split(':');
        const hariAktif = config.hari_aktif || '1,2,3,4,5';
        const cronExpression = `${parseInt(minute)} ${parseInt(hour)} * * ${hariAktif}`;

        console.log(`⏰ Jadwal Cek Ketidakhadiran aktif pukul ${hour}:${minute} WIB (Hari: ${hariAktif})`);

        activeTask = cron.schedule(cronExpression, async () => {
            await jalankanPengecekanAlpa(db, io, config);
        });
    } catch (err) {
        console.error('Gagal memuat jadwal cron:', err);
    }
}

async function jalankanPengecekanAlpa(db, io, config) {
    console.log('🔍 Menjalankan pengecekan otomatis siswa tidak hadir...');
    const today = new Date().toISOString().split('T')[0];

    try {
        const [absentStudents] = await db.query(`
            SELECT s.id, s.nama_siswa, s.no_wa_ortu, k.id AS kelas_id, k.nama_kelas, k.wali_kelas, k.no_wa_wali 
            FROM siswa s
            JOIN kelas k ON s.kelas_id = k.id
            WHERE s.id NOT IN (SELECT siswa_id FROM absensi WHERE tanggal = ?::date)
            ORDER BY k.nama_kelas, s.nama_siswa
        `, [today]);

        const rekapPerKelas = {};

        for (const siswa of absentStudents) {
            await db.query(
                `INSERT INTO absensi (siswa_id, tanggal, status) VALUES (?, ?::date, 'Alpa') ON CONFLICT (siswa_id, tanggal) DO NOTHING`,
                [siswa.id, today]
            );

            const pesanOrtu = `Assalamu'alaikum Wr. Wb.\n\n*INFORMASI KEHADIRAN - ${config.nama_sekolah}*\n\nAnanda *${siswa.nama_siswa}* (${siswa.nama_kelas}) hingga pukul *${config.jam_cek_alpa.slice(0, 5)} WIB* hari ini belum tercatat hadir di sekolah.\n\nApakah ananda berhalangan hadir? Silakan balas pesan ini dengan mengetik kata:\n*Sakit*\n*Izin*\n*Tanpa Keterangan*\n\nTerima kasih.`;
            queueMessage(siswa.no_wa_ortu, pesanOrtu);

            if (siswa.no_wa_wali) {
                if (!rekapPerKelas[siswa.kelas_id]) {
                    rekapPerKelas[siswa.kelas_id] = {
                        nama_kelas: siswa.nama_kelas,
                        wali_kelas: siswa.wali_kelas || 'Bapak/Ibu Wali Kelas',
                        no_wa_wali: siswa.no_wa_wali,
                        daftar_siswa: []
                    };
                }
                rekapPerKelas[siswa.kelas_id].daftar_siswa.push(siswa.nama_siswa);
            }
        }

        for (const kelasId in rekapPerKelas) {
            const info = rekapPerKelas[kelasId];
            const listNama = info.daftar_siswa.map((nama, idx) => `${idx + 1}. ${nama}`).join('\n');
            const pesanWali = `Assalamu'alaikum Wr. Wb.\nYth. *${info.wali_kelas}*\nWali Kelas *${info.nama_kelas}* - ${config.nama_sekolah}\n\nBerikut daftar siswa kelas *${info.nama_kelas}* yang belum melakukan absensi hingga pukul *${config.jam_cek_alpa.slice(0, 5)} WIB* hari ini:\n\n${listNama}\n\nSistem telah mengirimkan pesan konfirmasi otomatis kepada orang tua siswa yang bersangkutan.`;
            queueMessage(info.no_wa_wali, pesanWali);
        }

        if (io) io.emit('refresh_dashboard');
        return absentStudents.length;
    } catch (error) {
        console.error('Error saat pengecekan alpa:', error);
        return 0;
    }
}

module.exports = {
    initCronJobs: startOrReloadCron,
    startOrReloadCron,
    jalankanPengecekanAlpa
};