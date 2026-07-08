const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Gelen JSON verilerini ve form verilerini okuyabilmek için middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// public klasöründeki HTML/CSS dosyalarını dışarıya aç
app.use(express.static('public'));

// PostgreSQL Bağlantı Havuzu (Pool) Kurulumu
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- OTOMATİK VERİ ZENGİNLEŞTİRME (MOCK API) ---
function fetchCarSpecsFromAPI(brand, model) {
    // Bu kısım gerçek dünyada dışarıya fetch() atılan yerdir. 
    // Sunum güvenliği için verileri burada simüle ediyoruz.
    const db = {
        "audi rs6": { zero_to_hundred: "3.6 sn", top_speed: "305 km/s", transmission: "8 İleri Tiptronic" },
        "ferrari f12": { zero_to_hundred: "3.1 sn", top_speed: "340 km/s", transmission: "7 İleri Çift Kavrama" },
        "porsche 911": { zero_to_hundred: "2.7 sn", top_speed: "330 km/s", transmission: "8 İleri PDK" },
        "mercedes g63": { zero_to_hundred: "4.5 sn", top_speed: "220 km/s", transmission: "9G-TRONIC" },
        "bmw m5": { zero_to_hundred: "3.4 sn", top_speed: "305 km/s", transmission: "8 İleri M Steptronic" }
    };

    const searchKey = `${brand} ${model}`.toLowerCase();
    
    // Eğer araç sözlükte varsa verilerini dön, yoksa standart değerler ata
    if (db[searchKey]) {
        return db[searchKey];
    } else {
        return { zero_to_hundred: "Belirtilmedi", top_speed: "Belirtilmedi", transmission: "Otomatik" };
    }
}

// Veritabanı bağlantısını test et
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Veritabanına bağlanırken hata oluştu:', err.stack);
    }
    console.log('PostgreSQL Veritabanına Başarıyla Bağlanıldı! 🚀');
    release();
});

// Basit bir test rotası
app.get('/api/test', async (req, res) => {
    res.json({ message: "KNZ Motors Backend Sistemi Hazır!" });
});

// YENİ ARAÇ EKLEME (Otomatik Teknik Veri Çekimi İle)
app.post('/api/cars', async (req, res) => {
    try {
        const { brand, model, horsepower, price_per_day, image_url } = req.body;
        
        // 1. Dış API'den (veya yerel simülasyondan) aracın teknik detaylarını otomatik bul
        const specs = fetchCarSpecsFromAPI(brand, model);

        // 2. Hem formdan gelenleri hem de otomatik bulunan verileri veritabanına kaydet
        const newCar = await pool.query(
            `INSERT INTO cars 
            (brand, model, horsepower, price_per_day, image_url, zero_to_hundred, top_speed, transmission) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [brand, model, horsepower, price_per_day, image_url, specs.zero_to_hundred, specs.top_speed, specs.transmission]
        );
        
        res.status(201).json(newCar.rows[0]);
    } catch (err) {
        console.error("Araç eklenirken hata:", err.message);
        res.status(500).json({ error: "Sunucu hatası" });
    }
}); 

// TÜM ARAÇLARI GETİRME (Ana Site İçin)
app.get('/api/cars', async (req, res) => {
    try {
        const allCars = await pool.query('SELECT * FROM cars ORDER BY id DESC');
        res.json(allCars.rows);
    } catch (err) {
        console.error("Araçlar çekilirken hata:", err.message);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// YENİ REZERVASYON (KİRALAMA) OLUŞTURMA
app.post('/api/reservations', async (req, res) => {
    // Formdan gelen verileri alıyoruz
    const { car_id, full_name, email, phone, start_date, end_date, total_price, custom_plate } = req.body;
    
    try {
        // 1. Önce müşteriyi veritabanında ara (Email'e göre)
        let userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        let user_id;
        
        // Müşteri yoksa yeni kayıt oluştur
        if (userResult.rows.length === 0) {
            const newUser = await pool.query(
                'INSERT INTO users (full_name, email, phone) VALUES ($1, $2, $3) RETURNING id',
                [full_name, email, phone]
            );
            user_id = newUser.rows[0].id;
        } else {
            // Müşteri zaten varsa onun ID'sini kullan
            user_id = userResult.rows[0].id;
        }

        // 2. Rezervasyonu oluştur ve Özel Plakayı kaydet
        const newRes = await pool.query(
            'INSERT INTO reservations (car_id, user_id, start_date, end_date, total_price, custom_plate) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [car_id, user_id, start_date, end_date, total_price, custom_plate]
        );
        
        // 3. Aracı "Kirada" olarak güncelle (Müsaitliği kapat)
        await pool.query('UPDATE cars SET is_available = false WHERE id = $1', [car_id]);
        
        res.status(201).json({ message: "Rezervasyon başarıyla tamamlandı!" });
    } catch (err) {
        console.error("Rezervasyon sırasında hata:", err.message);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// TÜM REZERVASYONLARI GETİRME (Admin Dashboard İçin - JOIN İşlemi)
app.get('/api/reservations', async (req, res) => {
    try {
        // 3 tabloyu birbiriyle konuşturuyoruz (JOIN)
        const query = `
            SELECT 
                r.id AS res_id, 
                c.brand, 
                c.model, 
                u.full_name, 
                u.email,
                r.start_date, 
                r.end_date, 
                r.total_price, 
                r.custom_plate
            FROM reservations r
            JOIN cars c ON r.car_id = c.id
            JOIN users u ON r.user_id = u.id
            ORDER BY r.id DESC
        `;
        
        const allReservations = await pool.query(query);
        res.json(allReservations.rows);
    } catch (err) {
        console.error("Rezervasyonlar çekilirken hata:", err.message);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// 1. TEK BİR ARACIN DETAYINI GETİR (Araç Detay Sayfası İçin)
app.get('/api/cars/:id', async (req, res) => {
    try {
        const car = await pool.query('SELECT * FROM cars WHERE id = $1', [req.params.id]);
        if (car.rows.length === 0) return res.status(404).json({ error: 'Araç bulunamadı' });
        res.json(car.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// 2. ARAÇ SİLME (Filodan Çıkarma)
app.delete('/api/cars/:id', async (req, res) => {
    try {
        // Önce araca bağlı rezervasyonları sil (Foreign Key hatasını önlemek için)
        await pool.query('DELETE FROM reservations WHERE car_id = $1', [req.params.id]);
        // Sonra aracı sil
        await pool.query('DELETE FROM cars WHERE id = $1', [req.params.id]);
        res.json({ message: "Araç başarıyla silindi" });
    } catch (err) {
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// 3. REZERVASYON (MÜŞTERİ) SİLME / İPTAL ETME
app.delete('/api/reservations/:id', async (req, res) => {
    try {
        // İptal edilen aracı bulup tekrar "Müsait" (is_available = true) yapıyoruz
        const resData = await pool.query('SELECT car_id FROM reservations WHERE id = $1', [req.params.id]);
        if (resData.rows.length > 0) {
            await pool.query('UPDATE cars SET is_available = true WHERE id = $1', [resData.rows[0].car_id]);
        }
        await pool.query('DELETE FROM reservations WHERE id = $1', [req.params.id]);
        res.json({ message: "Rezervasyon iptal edildi" });
    } catch (err) {
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// 4. REZERVASYON DÜZENLEME (Özel Plaka Güncelleme)
app.put('/api/reservations/:id', async (req, res) => {
    const { custom_plate } = req.body;
    try {
        await pool.query('UPDATE reservations SET custom_plate = $1 WHERE id = $2', [custom_plate, req.params.id]);
        res.json({ message: "Rezervasyon güncellendi" });
    } catch (err) {
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// Sunucuyu Çalıştır
app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde tıkır tıkır çalışıyor.`);
});