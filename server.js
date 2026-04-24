const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key';

// ============ CLOUDINARY CONFIG ============
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'YOUR_CLOUD_NAME',
    api_key: process.env.CLOUDINARY_API_KEY || 'YOUR_API_KEY',
    api_secret: process.env.CLOUDINARY_API_SECRET || 'YOUR_API_SECRET'
});

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ DATABASE (JSON) ============
const DB_PATH = path.join(__dirname, 'database.json');

function readDB() {
    if (!fs.existsSync(DB_PATH)) return null;
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
}

function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function initDatabase() {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    const initialData = {
        users: [{
            id: 1, username: 'admin', email: 'admin@fileshare.com',
            password: hashedPassword, role: 'admin', created_at: new Date().toISOString()
        }],
        files: [],
        upload_queue: [],
        reports: [],
        rejected_files: [],
        next_id: { user: 2, queue: 1, report: 1 }
    };
    
    if (!fs.existsSync(DB_PATH)) {
        writeDB(initialData);
        console.log('✅ Database created with admin user: admin / admin123');
    }
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    socket.on('register-user', (userId) => {
        console.log(`✅ User ${userId} registered`);
    });
});

function broadcastNewFile(file) {
    io.emit('new-file', file);
}

function broadcastFileDeleted(fileId) {
    io.emit('file-deleted', fileId);
}

// ============ AUTH MIDDLEWARE ============
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const requireAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') next();
    else res.status(403).json({ error: 'Admin access required' });
};

// ============ MULTER CONFIG (Temp storage) ============
const tempDir = path.join(__dirname, 'uploads', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
    destination: tempDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit

// ============ AUTH ROUTES ============
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Semua field harus diisi' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
    
    const db = readDB();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username sudah terdaftar' });
    if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email sudah terdaftar' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: db.next_id.user++, username, email, password: hashedPassword,
        role: 'user', created_at: new Date().toISOString()
    };
    db.users.push(newUser);
    writeDB(db);
    res.json({ success: true, message: 'Registrasi berhasil! Silakan login.' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: 'Username atau password salah' });
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Username atau password salah' });
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

// ============ FILE ROUTES ============
app.get('/api/files', async (req, res) => {
    const db = readDB();
    let files = [...db.files];
    const { search, category, sort, page = 1, limit = 20 } = req.query;
    
    if (search) files = files.filter(f => f.original_name.toLowerCase().includes(search.toLowerCase()) || (f.description && f.description.toLowerCase().includes(search.toLowerCase())));
    if (category && category !== 'all') files = files.filter(f => f.category === category);
    if (sort === 'downloads') files.sort((a, b) => b.download_count - a.download_count);
    else files.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    
    const users = db.users;
    const filesWithUploader = files.map(f => ({ ...f, uploader_name: users.find(u => u.id === f.uploaded_by)?.username || 'Unknown' }));
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginatedFiles = filesWithUploader.slice(start, start + parseInt(limit));
    
    res.json({ files: paginatedFiles, total_files: files.length, current_page: parseInt(page), total_pages: Math.ceil(files.length / limit) });
});

app.post('/api/download/:id', async (req, res) => {
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.id);
    if (fileIndex !== -1) {
        db.files[fileIndex].download_count = (db.files[fileIndex].download_count || 0) + 1;
        writeDB(db);
    }
    res.json({ success: true });
});

// DOWNLOAD dari Cloudinary
app.get('/api/download/:id', async (req, res) => {
    const db = readDB();
    const file = db.files.find(f => f.id === req.params.id);
    
    if (!file) {
        return res.status(404).send('File not found');
    }
    
    if (!file.cloudinary_url) {
        return res.status(404).send('File URL not found');
    }
    
    // Redirect ke URL Cloudinary untuk download
    res.redirect(file.cloudinary_url + '?download=1');
});

// ============ UPLOAD ROUTES ============
app.post('/api/upload/submit', authenticate, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
        
        const db = readDB();
        const { description, category } = req.body;
        
        const newQueueItem = {
            id: db.next_id.queue++,
            temp_path: req.file.path,
            original_name: req.file.originalname,
            file_size: req.file.size,
            mime_type: req.file.mimetype,
            uploaded_by: req.user.id,
            description: description || '',
            category: category || 'Other',
            status: 'pending',
            submitted_at: new Date().toISOString()
        };
        
        db.upload_queue.push(newQueueItem);
        writeDB(db);
        
        res.json({ success: true, message: 'File dikirim untuk verifikasi', queue_id: newQueueItem.id });
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Gagal upload' });
    }
});

app.get('/api/upload/my-uploads', authenticate, async (req, res) => {
    const db = readDB();
    res.json({
        queues: db.upload_queue.filter(q => q.uploaded_by === req.user.id && q.status === 'pending'),
        approved: db.files.filter(f => f.uploaded_by === req.user.id),
        rejected: db.rejected_files.filter(r => r.uploaded_by === req.user.id)
    });
});

// ============ ADMIN ROUTES ============
app.get('/api/admin/queue', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const pending = db.upload_queue.filter(q => q.status === 'pending');
    const users = db.users;
    res.json({ queues: pending.map(q => ({ ...q, uploader_name: users.find(u => u.id === q.uploaded_by)?.username || 'Unknown' })) });
});

// APPROVE dengan upload ke Cloudinary
app.post('/api/admin/approve/:queueId', authenticate, requireAdmin, async (req, res) => {
    try {
        const db = readDB();
        const queueIndex = db.upload_queue.findIndex(q => q.id === parseInt(req.params.queueId) && q.status === 'pending');
        
        if (queueIndex === -1) {
            return res.status(404).json({ error: 'Queue item not found' });
        }
        
        const queueItem = db.upload_queue[queueIndex];
        
        // Upload ke Cloudinary
        console.log('📤 Uploading to Cloudinary:', queueItem.original_name);
        const cloudinaryResult = await cloudinary.uploader.upload(queueItem.temp_path, {
            resource_type: 'auto',
            folder: 'fileshare',
            public_id: `file_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`
        });
        
        console.log('✅ Uploaded to Cloudinary:', cloudinaryResult.secure_url);
        
        // Hapus file temp
        if (fs.existsSync(queueItem.temp_path)) {
            fs.unlinkSync(queueItem.temp_path);
        }
        
        const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        
        const newFile = {
            id: fileId,
            original_name: queueItem.original_name,
            size: queueItem.file_size,
            mime_type: queueItem.mime_type,
            cloudinary_url: cloudinaryResult.secure_url,
            cloudinary_public_id: cloudinaryResult.public_id,
            uploaded_by: queueItem.uploaded_by,
            description: queueItem.description || '',
            category: queueItem.category || 'Other',
            download_count: 0,
            uploaded_at: new Date().toISOString()
        };
        
        db.files.push(newFile);
        db.upload_queue[queueIndex].status = 'approved';
        db.upload_queue[queueIndex].reviewed_at = new Date().toISOString();
        db.upload_queue[queueIndex].reviewed_by = req.user.id;
        writeDB(db);
        
        const users = db.users;
        const fileWithUploader = {
            ...newFile,
            uploader_name: users.find(u => u.id === newFile.uploaded_by)?.username || 'Unknown'
        };
        broadcastNewFile(fileWithUploader);
        
        res.json({ success: true, message: 'File approved and uploaded to Cloudinary', file_id: fileId });
    } catch (error) {
        console.error('Cloudinary upload error:', error);
        res.status(500).json({ error: 'Failed to upload to Cloudinary: ' + error.message });
    }
});

app.post('/api/admin/reject/:queueId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const queueIndex = db.upload_queue.findIndex(q => q.id === parseInt(req.params.queueId) && q.status === 'pending');
    
    if (queueIndex === -1) return res.status(404).json({ error: 'Queue item not found' });
    
    const queueItem = db.upload_queue[queueIndex];
    if (fs.existsSync(queueItem.temp_path)) fs.unlinkSync(queueItem.temp_path);
    
    db.rejected_files.push({
        id: db.rejected_files.length + 1,
        original_name: queueItem.original_name,
        file_size: queueItem.file_size,
        uploaded_by: queueItem.uploaded_by,
        description: queueItem.description,
        category: queueItem.category,
        reject_reason: req.body.reason || 'Ditolak oleh admin',
        rejected_at: new Date().toISOString()
    });
    
    db.upload_queue[queueIndex].status = 'rejected';
    db.upload_queue[queueIndex].admin_note = req.body.reason || 'Ditolak oleh admin';
    db.upload_queue[queueIndex].reviewed_at = new Date().toISOString();
    db.upload_queue[queueIndex].reviewed_by = req.user.id;
    writeDB(db);
    
    res.json({ success: true, message: 'File rejected' });
});

// ============ REPORT ROUTES ============
app.post('/api/report', authenticate, async (req, res) => {
    const { file_id, reason, description } = req.body;
    const db = readDB();
    db.reports.push({
        id: 'report_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        file_id, reported_by: req.user.id, reason, description: description || '',
        status: 'pending', created_at: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true, message: 'Laporan terkirim' });
});

app.get('/api/admin/reports', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const pendingReports = db.reports.filter(r => r.status === 'pending');
    const users = db.users;
    const files = db.files;
    res.json({ reports: pendingReports.map(r => ({
        ...r, reporter_name: users.find(u => u.id === r.reported_by)?.username || 'Unknown',
        file_name: files.find(f => f.id === r.file_id)?.original_name || 'File sudah dihapus'
    })) });
});

app.post('/api/admin/delete-file/:fileId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    
    if (fileIndex !== -1) {
        const file = db.files[fileIndex];
        
        // Hapus dari Cloudinary
        if (file.cloudinary_public_id) {
            try {
                await cloudinary.uploader.destroy(file.cloudinary_public_id);
                console.log('Deleted from Cloudinary:', file.cloudinary_public_id);
            } catch (err) {
                console.error('Failed to delete from Cloudinary:', err);
            }
        }
        
        db.files.splice(fileIndex, 1);
        writeDB(db);
        broadcastFileDeleted(req.params.fileId);
    }
    res.json({ success: true });
});

app.post('/api/admin/ignore-report/:reportId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const reportIndex = db.reports.findIndex(r => r.id === req.params.reportId);
    if (reportIndex !== -1) {
        db.reports[reportIndex].status = 'ignored';
        db.reports[reportIndex].resolved_at = new Date().toISOString();
        writeDB(db);
    }
    res.json({ success: true });
});

// ============ EDIT & DELETE FILE ============
app.put('/api/file/:fileId', authenticate, async (req, res) => {
    const { description, category } = req.body;
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    
    if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });
    if (db.files[fileIndex].uploaded_by !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only edit your own files' });
    }
    
    db.files[fileIndex].description = description || '';
    db.files[fileIndex].category = category || 'Other';
    writeDB(db);
    res.json({ success: true });
});

app.delete('/api/file/:fileId', authenticate, async (req, res) => {
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    
    if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });
    if (db.files[fileIndex].uploaded_by !== req.user.id && db.files[fileIndex].uploaded_by !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only delete your own files' });
    }
    
    const file = db.files[fileIndex];
    
    // Hapus dari Cloudinary
    if (file.cloudinary_public_id) {
        try {
            await cloudinary.uploader.destroy(file.cloudinary_public_id);
            console.log('Deleted from Cloudinary:', file.cloudinary_public_id);
        } catch (err) {
            console.error('Failed to delete from Cloudinary:', err);
        }
    }
    
    db.files.splice(fileIndex, 1);
    writeDB(db);
    broadcastFileDeleted(req.params.fileId);
    res.json({ success: true });
});

// ============ STATS ============
app.get('/api/stats', async (req, res) => {
    const db = readDB();
    res.json({
        total_files: db.files.length,
        total_downloads: db.files.reduce((sum, f) => sum + (f.download_count || 0), 0),
        total_users: db.users.length
    });
});

// ============ SERVE FRONTEND ============
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============
initDatabase();
// ============ AUTO BACKUP TO GITHUB ============
const { exec } = require('child_process');

// Konfigurasi GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const BACKUP_INTERVAL = 5 * 60 * 1000; // Backup setiap 5 menit

// Fungsi untuk backup ke GitHub
async function backupToGitHub() {
    console.log('📦 Starting backup to GitHub...');
    
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        console.log('⚠️ GITHUB_TOKEN or GITHUB_REPO not set, skipping backup');
        return;
    }
    
    const dbPath = path.join(__dirname, 'database.json');
    if (!fs.existsSync(dbPath)) {
        console.log('❌ database.json not found, skipping backup');
        return;
    }
    
    try {
        // Backup database.json
        const commands = [
            'git config user.name "Auto Backup Bot"',
            'git config user.email "backup@fileshare.local"',
            `git remote set-url origin https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`,
            'git pull origin main --no-rebase --allow-unrelated-histories || true',
            'git add database.json',
            `git commit -m "Auto backup: ${new Date().toLocaleString()}" || echo "No changes to commit"`,
            'git push origin main'
        ];
        
        for (const cmd of commands) {
            await new Promise((resolve) => {
                exec(cmd, { cwd: __dirname }, (error, stdout, stderr) => {
                    if (error && !cmd.includes('||')) {
                        console.log(`Command failed: ${cmd}`);
                    } else {
                        if (stdout) console.log(stdout.substring(0, 200));
                    }
                    resolve();
                });
            });
        }
        
        console.log('✅ Backup completed!');
    } catch (error) {
        console.log('❌ Backup failed:', error.message);
    }
}

// Fungsi untuk restore dari backup
async function restoreFromBackup() {
    console.log('🔄 Checking for backup to restore...');
    
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        console.log('⚠️ GitHub credentials not set, skipping restore');
        return false;
    }
    
    const dbPath = path.join(__dirname, 'database.json');
    
    try {
        // Pull latest database.json dari GitHub
        await new Promise((resolve) => {
            exec(`git pull origin main`, { cwd: __dirname }, (error) => {
                resolve();
            });
        });
        
        // Cek apakah database.json ada dan memiliki data
        if (fs.existsSync(dbPath)) {
            const dbData = fs.readFileSync(dbPath, 'utf8');
            const db = JSON.parse(dbData);
            
            // Jika hanya ada admin (1 user) dan tidak ada file, skip restore
            if (db.users && db.users.length <= 1 && db.files.length === 0) {
                console.log('No meaningful data in backup, skipping restore');
                return false;
            }
            
            console.log(`✅ Restored from backup: ${db.users.length} users, ${db.files.length} files`);
            return true;
        }
    } catch (error) {
        console.log('No backup found or restore failed');
    }
    return false;
}

// Endpoint manual backup (hanya admin)
app.post('/api/admin/backup', authenticate, requireAdmin, async (req, res) => {
    try {
        await backupToGitHub();
        res.json({ success: true, message: 'Backup completed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint manual restore (hanya admin)
app.post('/api/admin/restore', authenticate, requireAdmin, async (req, res) => {
    try {
        const restored = await restoreFromBackup();
        if (restored) {
            res.json({ success: true, message: 'Restore completed. Restarting...' });
            setTimeout(() => process.exit(0), 1000);
        } else {
            res.json({ success: false, message: 'No backup to restore' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Jalankan restore saat server mulai (hanya jika database kosong)
(async () => {
    const dbPath = path.join(__dirname, 'database.json');
    if (fs.existsSync(dbPath)) {
        const dbData = fs.readFileSync(dbPath, 'utf8');
        const db = JSON.parse(dbData);
        // Jika hanya admin saja (data kosong), coba restore
        if (db.users && db.users.length <= 1 && db.files.length === 0) {
            await restoreFromBackup();
        }
    }
})();

// Mulai backup scheduler
setTimeout(() => {
    backupToGitHub();
}, 60 * 1000); // Backup pertama setelah 1 menit

setInterval(() => {
    backupToGitHub();
}, BACKUP_INTERVAL);

console.log(`💾 Auto backup system initialized (every ${BACKUP_INTERVAL / 60000} minutes)`);
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`☁️ Cloudinary storage enabled`);
    console.log(`🔐 Admin: admin / admin123\n`);
});