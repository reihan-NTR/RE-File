const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = 3000;
const JWT_SECRET = 'your_super_secret_key';


// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ DATABASE (JSON) ============
const DB_PATH = path.join(__dirname, 'database.json');

function readDB() {
    if (!fs.existsSync(DB_PATH)) {
        return { users: [], files: [], upload_queue: [], reports: [], rejected_files: [], next_id: { user: 2, queue: 1, report: 1 } };
    }
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
}

function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function initDatabase() {
    if (!fs.existsSync(DB_PATH)) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        const initialData = {
            users: [{
                id: 1,
                username: 'admin',
                email: 'admin@fileshare.com',
                password: hashedPassword,
                role: 'admin',
                created_at: new Date().toISOString()
            }],
            files: [],
            upload_queue: [],
            reports: [],
            rejected_files: [],
            next_id: { user: 2, queue: 1, report: 1 }
        };
        writeDB(initialData);
        console.log('✅ Database created with admin: admin / admin123');
    }
}

// ============ SOCKET.IO REAL-TIME ============
// Menyimpan koneksi user yang sedang online
const onlineUsers = new Map();

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    socket.on('register-user', (userId) => {
        onlineUsers.set(userId, socket.id);
        console.log(`✅ User ${userId} registered, online: ${onlineUsers.size}`);
    });
    
    socket.on('disconnect', () => {
        for (let [userId, socketId] of onlineUsers.entries()) {
            if (socketId === socket.id) {
                onlineUsers.delete(userId);
                console.log(`❌ User ${userId} disconnected`);
                break;
            }
        }
    });
});

// Fungsi untuk broadcast ke semua client
function broadcastNewFile(file) {
    console.log('📢 Broadcasting new file:', file.original_name);
    io.emit('new-file', file);
}

function broadcastFileDeleted(fileId) {
    console.log('📢 Broadcasting file deletion:', fileId);
    io.emit('file-deleted', fileId);
}

function broadcastFileUpdated(fileId, newData) {
    console.log('📢 Broadcasting file update:', fileId);
    io.emit('file-updated', { id: fileId, ...newData });
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

// ============ MULTER CONFIG ============
const tempDir = path.join(__dirname, 'uploads', 'temp');
const filesDir = path.join(__dirname, 'uploads', 'files');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

const storage = multer.diskStorage({
    destination: tempDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

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
        id: db.next_id.user++,
        username,
        email,
        password: hashedPassword,
        role: 'user',
        created_at: new Date().toISOString()
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
    
    if (search) files = files.filter(f => f.original_name.toLowerCase().includes(search.toLowerCase()));
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

app.get('/api/download/:id', async (req, res) => {
    try {
        const db = readDB();
        const file = db.files.find(f => f.id === req.params.id);
        
        if (!file) {
            console.log('File not found in database:', req.params.id);
            return res.status(404).send('File tidak ditemukan di database');
        }
        
        // Cek beberapa kemungkinan lokasi file
        let filePath = file.stored_name;
        
        // Jika stored_name sudah path absolut
        if (path.isAbsolute(filePath)) {
            // Gunakan langsung
        } 
        // Jika stored_name dimulai dengan 'uploads/'
        else if (filePath.startsWith('uploads')) {
            filePath = path.join(__dirname, filePath);
        }
        // Jika hanya nama file
        else {
            filePath = path.join(__dirname, 'uploads', 'files', filePath);
        }
        
        console.log('Looking for file at:', filePath);
        
        if (!fs.existsSync(filePath)) {
            console.log('File not found on disk:', filePath);
            return res.status(404).send('File tidak ditemukan di server');
        }
        
        res.download(filePath, file.original_name);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send('Terjadi kesalahan saat download');
    }
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
        res.json({ success: true, message: 'File dikirim untuk verifikasi' });
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

app.post('/api/admin/approve/:queueId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const queueIndex = db.upload_queue.findIndex(q => q.id === parseInt(req.params.queueId) && q.status === 'pending');
    
    if (queueIndex === -1) {
        return res.status(404).json({ error: 'Queue item not found' });
    }
    
    const queueItem = db.upload_queue[queueIndex];
    const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    const extension = path.extname(queueItem.original_name);
    const storedFileName = fileId + extension;
    const storedPath = path.join(filesDir, storedFileName);
    const relativePath = 'uploads/files/' + storedFileName;
    
    // Pindahkan file
    fs.renameSync(queueItem.temp_path, storedPath);
    
    const newFile = {
        id: fileId,
        original_name: queueItem.original_name,
        stored_name: relativePath,
        size: queueItem.file_size,
        mime_type: queueItem.mime_type,
        uploaded_by: queueItem.uploaded_by,
        description: queueItem.description,
        category: queueItem.category,
        download_count: 0,
        uploaded_at: new Date().toISOString()
    };
    
    db.files.push(newFile);
    db.upload_queue[queueIndex].status = 'approved';
    writeDB(db);
    
    // 📢 BROADCAST KE SEMUA USER
    const users = db.users;
    const fileWithUploader = {
        ...newFile,
        uploader_name: users.find(u => u.id === newFile.uploaded_by)?.username || 'Unknown'
    };
    broadcastNewFile(fileWithUploader);
    
    res.json({ success: true, message: 'File approved' });
});

app.post('/api/admin/reject/:queueId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const queueIndex = db.upload_queue.findIndex(q => q.id === parseInt(req.params.queueId) && q.status === 'pending');
    if (queueIndex === -1) return res.status(404).json({ error: 'Queue item not found' });
    
    const queueItem = db.upload_queue[queueIndex];
    if (fs.existsSync(queueItem.temp_path)) fs.unlinkSync(queueItem.temp_path);
    
    db.rejected_files.push({
        original_name: queueItem.original_name,
        file_size: queueItem.file_size,
        uploaded_by: queueItem.uploaded_by,
        description: queueItem.description,
        category: queueItem.category,
        reject_reason: req.body.reason || 'Ditolak oleh admin',
        rejected_at: new Date().toISOString()
    });
    db.upload_queue[queueIndex].status = 'rejected';
    writeDB(db);
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
// ============ REPORT ROUTES ============
app.post('/api/report', authenticate, async (req, res) => {
    const { file_id, reason, description } = req.body;
    const db = readDB();
    
    db.reports.push({
        id: 'report_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        file_id: file_id,
        reported_by: req.user.id,
        reason: reason,
        description: description || '',
        status: 'pending',
        created_at: new Date().toISOString()
    });
    writeDB(db);
    
    res.json({ success: true, message: 'Laporan terkirim' });
});

app.get('/api/admin/reports', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const pendingReports = db.reports.filter(r => r.status === 'pending');
    const users = db.users;
    const files = db.files;
    
    res.json({ 
        reports: pendingReports.map(r => ({
            ...r,
            reporter_name: users.find(u => u.id === r.reported_by)?.username || 'Unknown',
            file_name: files.find(f => f.id === r.file_id)?.original_name || 'File sudah dihapus'
        }))
    });
});

app.post('/api/admin/delete-file/:fileId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    
    if (fileIndex !== -1) {
        const file = db.files[fileIndex];
        const filePath = path.join(__dirname, file.stored_name);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        db.files.splice(fileIndex, 1);
        writeDB(db);
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
// ============ SERVE FRONTEND ============
// ============ EDIT & DELETE FILE (for owner) ============
app.put('/api/file/:fileId', authenticate, async (req, res) => {
    const { description, category } = req.body;
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    
    if (fileIndex === -1) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    const file = db.files[fileIndex];
    if (file.uploaded_by !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only edit your own files' });
    }
    
    db.files[fileIndex].description = description || '';
    db.files[fileIndex].category = category || 'Other';
    writeDB(db);
    
    // 📢 BROADCAST UPDATE
    broadcastFileUpdated(req.params.fileId, { description, category });
    
    res.json({ success: true, message: 'File updated' });
});

// ============ TAMBAHKAN ROUTE DELETE INI ============
app.delete('/api/file/:fileId', authenticate, async (req, res) => {
    try {
        const db = readDB();
        const fileId = req.params.fileId;
        
        const fileIndex = db.files.findIndex(f => f.id === fileId);
        
        if (fileIndex === -1) {
            return res.status(404).json({ error: 'File tidak ditemukan' });
        }
        
        const file = db.files[fileIndex];
        
        if (file.uploaded_by !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Anda hanya bisa menghapus file sendiri' });
        }
        
        // Hapus file fisik
        let filePath = file.stored_name;
        if (!path.isAbsolute(filePath)) {
            filePath = path.join(__dirname, file.stored_name);
        }
        
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        db.files.splice(fileIndex, 1);
        writeDB(db);
        
        // 📢 BROADCAST KE SEMUA USER
        broadcastFileDeleted(fileId);
        
        res.json({ success: true, message: 'File berhasil dihapus' });
        
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Gagal menghapus file' });
    }
});
app.use(express.static('public'));

// PERBAIKAN: Ganti app.get('*', ...) dengan app.use
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ============ REPORT ROUTES (LENGKAP) ============
app.post('/api/report', authenticate, async (req, res) => {
    const { file_id, reason, description } = req.body;
    const db = readDB();
    
    // Cek apakah file masih ada
    const fileExists = db.files.some(f => f.id === file_id);
    if (!fileExists) {
        return res.status(404).json({ error: 'File tidak ditemukan' });
    }
    
    // Cek apakah sudah pernah report oleh user ini
    const alreadyReported = db.reports.some(r => r.file_id === file_id && r.reported_by === req.user.id && r.status === 'pending');
    if (alreadyReported) {
        return res.status(400).json({ error: 'Anda sudah melaporkan file ini' });
    }
    
    const newReport = {
        id: 'report_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        file_id: file_id,
        reported_by: req.user.id,
        reason: reason,
        description: description || '',
        status: 'pending',
        created_at: new Date().toISOString()
    };
    
    db.reports.push(newReport);
    writeDB(db);
    
    res.json({ success: true, message: 'Laporan terkirim ke admin' });
});

app.get('/api/admin/reports', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const reports = db.reports.filter(r => r.status === 'pending');
    const users = db.users;
    const files = db.files;
    
    const reportsWithDetails = reports.map(r => {
        const file = files.find(f => f.id === r.file_id);
        return {
            ...r,
            reporter_name: users.find(u => u.id === r.reported_by)?.username || 'Unknown',
            file_name: file?.original_name || 'File sudah dihapus',
            file_exists: !!file
        };
    });
    
    res.json({ reports: reportsWithDetails });
});

app.post('/api/admin/delete-file/:fileId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    
    if (fileIndex === -1) {
        return res.status(404).json({ error: 'File tidak ditemukan' });
    }
    
    const file = db.files[fileIndex];
    const filePath = path.join(__dirname, file.stored_name);
    
    // Hapus file fisik
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    
    // Hapus dari database
    db.files.splice(fileIndex, 1);
    
    // Update semua report terkait file ini
    db.reports.forEach(r => {
        if (r.file_id === req.params.fileId) {
            r.status = 'resolved';
            r.resolved_at = new Date().toISOString();
            r.action = 'deleted';
        }
    });
    
    writeDB(db);
    
    res.json({ success: true, message: 'File berhasil dihapus' });
});

app.post('/api/admin/ignore-report/:reportId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const reportIndex = db.reports.findIndex(r => r.id === req.params.reportId);
    
    if (reportIndex === -1) {
        return res.status(404).json({ error: 'Laporan tidak ditemukan' });
    }
    
    db.reports[reportIndex].status = 'ignored';
    db.reports[reportIndex].resolved_at = new Date().toISOString();
    db.reports[reportIndex].action = 'ignored';
    writeDB(db);
    
    res.json({ success: true, message: 'Laporan diabaikan' });
});
// ============ START SERVER ============
initDatabase();
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔐 Admin login: admin / admin123\n`);
});