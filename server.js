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

// ============ DATABASE SETUP ============
const DB_PATH = path.join(__dirname, 'database.json');

function readDB() {
    if (!fs.existsSync(DB_PATH)) {
        return { 
            users: [], 
            files: [], 
            upload_queue: [], 
            pending_edits: [], 
            pending_deletes: [], 
            reports: [], 
            rejected_files: [], 
            next_id: { user: 2, queue: 1, report: 1 } 
        };
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
            pending_edits: [],
            pending_deletes: [],
            reports: [],
            rejected_files: [],
            next_id: { user: 2, queue: 1, report: 1 }
        };
        writeDB(initialData);
        console.log('✅ Database created with admin: admin / admin123');
    } else {
        const db = readDB();
        let changed = false;
        if (!db.pending_edits) { db.pending_edits = []; changed = true; }
        if (!db.pending_deletes) { db.pending_deletes = []; changed = true; }
        if (changed) writeDB(db);
    }
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

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
});

function broadcastNewFile(file) {
    io.emit('new-file', file);
}

function broadcastFileDeleted(fileId) {
    io.emit('file-deleted', fileId);
}

function broadcastFileUpdated(fileId, newData) {
    io.emit('file-updated', { id: fileId, ...newData });
}

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
    
    if (search) {
        const s = search.toLowerCase();
        files = files.filter(f => 
            f.original_name.toLowerCase().includes(s) ||
            (f.title && f.title.toLowerCase().includes(s)) ||
            (f.description && f.description.toLowerCase().includes(s))
        );
    }
    if (category && category !== 'all') files = files.filter(f => f.category === category);
    if (sort === 'downloads') files.sort((a, b) => b.download_count - a.download_count);
    else files.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    
    const users = db.users;
    const filesWithUploader = files.map(f => ({ ...f, uploader_name: users.find(u => u.id === f.uploaded_by)?.username || 'Unknown' }));
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.json({ files: filesWithUploader.slice(start, start + parseInt(limit)), total_files: files.length });
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
    const db = readDB();
    const file = db.files.find(f => f.id === req.params.id);
    if (!file) return res.status(404).send('File not found');
    const filePath = path.join(__dirname, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    res.download(filePath, file.original_name);
});

// ============ UPLOAD ROUTES ============
app.post('/api/upload/submit', authenticate, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
        const db = readDB();
        const { title, description, category } = req.body;
        const newQueueItem = {
            id: db.next_id.queue++,
            temp_path: req.file.path,
            original_name: req.file.originalname,
            title: title || '',
            description: description || '',
            category: category || 'Other',
            file_size: req.file.size,
            uploaded_by: req.user.id,
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

// ============ ADMIN DOWNLOAD (Tanpa Auth, untuk pengecekan file) ============
app.get('/api/admin/queue-download/:queueId', async (req, res) => {
    const db = readDB();
    const queueId = parseInt(req.params.queueId);
    const queueItem = db.upload_queue.find(q => q.id === queueId && q.status === 'pending');
    
    if (!queueItem) {
        return res.status(404).send('File tidak ditemukan');
    }
    
    if (!queueItem.temp_path || !fs.existsSync(queueItem.temp_path)) {
        return res.status(404).send('File sudah tidak ada di server');
    }
    
    res.download(queueItem.temp_path, queueItem.original_name);
});

app.get('/api/admin/delete-download/:deleteId', async (req, res) => {
    const db = readDB();
    const deleteId = req.params.deleteId;
    const deleteReq = (db.pending_deletes || []).find(d => d.id === deleteId && d.status === 'pending');
    
    if (!deleteReq) {
        return res.status(404).send('Request tidak ditemukan');
    }
    
    const filePath = path.join(__dirname, deleteReq.stored_name);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File sudah tidak ada di server');
    }
    
    res.download(filePath, deleteReq.file_name);
});

// ============ ADMIN QUEUE (Upload Baru) ============
app.get('/api/admin/queue', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const pending = db.upload_queue.filter(q => q.status === 'pending');
    const users = db.users;
    res.json({ queues: pending.map(q => ({ ...q, uploader_name: users.find(u => u.id === q.uploaded_by)?.username || 'Unknown' })) });
});

app.post('/api/admin/approve/:queueId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const queueIndex = db.upload_queue.findIndex(q => q.id === parseInt(req.params.queueId) && q.status === 'pending');
    if (queueIndex === -1) return res.status(404).json({ error: 'Queue item not found' });
    
    const queueItem = db.upload_queue[queueIndex];
    const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    const extension = path.extname(queueItem.original_name);
    const storedPath = path.join(filesDir, fileId + extension);
    const relativePath = 'uploads/files/' + fileId + extension;
    
    fs.renameSync(queueItem.temp_path, storedPath);
    
    const newFile = {
        id: fileId,
        original_name: queueItem.original_name,
        title: queueItem.title || '',
        description: queueItem.description || '',
        category: queueItem.category || 'Other',
        stored_name: relativePath,
        size: queueItem.file_size,
        uploaded_by: queueItem.uploaded_by,
        download_count: 0,
        uploaded_at: new Date().toISOString()
    };
    
    db.files.push(newFile);
    db.upload_queue[queueIndex].status = 'approved';
    writeDB(db);
    
    const users = db.users;
    broadcastNewFile({ ...newFile, uploader_name: users.find(u => u.id === newFile.uploaded_by)?.username || 'Unknown' });
    res.json({ success: true });
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
    writeDB(db);
    res.json({ success: true });
});

// ============ REQUEST EDIT (Verifikasi Admin) ============
app.post('/api/file/edit-request/:fileId', authenticate, async (req, res) => {
    try {
        const { title, description, category } = req.body;
        const db = readDB();
        const fileId = req.params.fileId;
        const fileIndex = db.files.findIndex(f => f.id === fileId);
        if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });
        const file = db.files[fileIndex];
        if (file.uploaded_by !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'You can only edit your own files' });
        }
        if (!db.pending_edits) db.pending_edits = [];
        db.pending_edits.push({
            id: 'edit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            file_id: fileId,
            file_name: file.original_name,
            file_title: file.title || file.original_name,
            requested_by: req.user.id,
            requested_by_name: req.user.username,
            current_data: {
                title: file.title || '',
                description: file.description || '',
                category: file.category || 'Other'
            },
            requested_data: {
                title: title || '',
                description: description || '',
                category: category || 'Other'
            },
            status: 'pending',
            created_at: new Date().toISOString()
        });
        writeDB(db);
        res.json({ success: true, message: 'Edit request sent to admin' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit edit request' });
    }
});

// ============ REQUEST DELETE (Verifikasi Admin) ============
app.post('/api/file/delete-request/:fileId', authenticate, async (req, res) => {
    try {
        const db = readDB();
        const fileId = req.params.fileId;
        const fileIndex = db.files.findIndex(f => f.id === fileId);
        if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });
        const file = db.files[fileIndex];
        if (file.uploaded_by !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'You can only delete your own files' });
        }
        if (!db.pending_deletes) db.pending_deletes = [];
        db.pending_deletes.push({
            id: 'del_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            file_id: fileId,
            file_name: file.original_name,
            file_title: file.title || file.original_name,
            stored_name: file.stored_name,
            requested_by: req.user.id,
            requested_by_name: req.user.username,
            status: 'pending',
            created_at: new Date().toISOString()
        });
        writeDB(db);
        res.json({ success: true, message: 'Delete request sent to admin' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit delete request' });
    }
});

// ============ ADMIN PENDING EDITS ============
app.get('/api/admin/pending-edits', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const edits = (db.pending_edits || []).filter(e => e.status === 'pending');
    res.json({ edits });
});

app.post('/api/admin/approve-edit/:editId', authenticate, requireAdmin, async (req, res) => {
    try {
        const db = readDB();
        const editId = req.params.editId;
        const editIndex = (db.pending_edits || []).findIndex(e => e.id === editId && e.status === 'pending');
        if (editIndex === -1) return res.status(404).json({ error: 'Edit request not found' });
        const edit = db.pending_edits[editIndex];
        const fileIndex = db.files.findIndex(f => f.id === edit.file_id);
        if (fileIndex !== -1) {
            db.files[fileIndex].title = edit.requested_data.title;
            db.files[fileIndex].description = edit.requested_data.description;
            db.files[fileIndex].category = edit.requested_data.category;
        }
        db.pending_edits[editIndex].status = 'approved';
        db.pending_edits[editIndex].reviewed_at = new Date().toISOString();
        db.pending_edits[editIndex].reviewed_by = req.user.id;
        writeDB(db);
        broadcastFileUpdated(edit.file_id, edit.requested_data);
        res.json({ success: true, message: 'Edit approved' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reject-edit/:editId', authenticate, requireAdmin, async (req, res) => {
    try {
        const db = readDB();
        const editId = req.params.editId;
        const editIndex = (db.pending_edits || []).findIndex(e => e.id === editId && e.status === 'pending');
        if (editIndex === -1) return res.status(404).json({ error: 'Edit request not found' });
        db.pending_edits[editIndex].status = 'rejected';
        db.pending_edits[editIndex].reject_reason = req.body.reason || 'Ditolak admin';
        db.pending_edits[editIndex].reviewed_at = new Date().toISOString();
        db.pending_edits[editIndex].reviewed_by = req.user.id;
        writeDB(db);
        res.json({ success: true, message: 'Edit rejected' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ ADMIN PENDING DELETES ============
app.get('/api/admin/pending-deletes', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const deletes = (db.pending_deletes || []).filter(d => d.status === 'pending');
    res.json({ deletes });
});

app.post('/api/admin/approve-delete/:deleteId', authenticate, requireAdmin, async (req, res) => {
    try {
        const db = readDB();
        const deleteId = req.params.deleteId;
        const delIndex = (db.pending_deletes || []).findIndex(d => d.id === deleteId && d.status === 'pending');
        if (delIndex === -1) return res.status(404).json({ error: 'Delete request not found' });
        const del = db.pending_deletes[delIndex];
        const filePath = path.join(__dirname, del.stored_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        const fileIndex = db.files.findIndex(f => f.id === del.file_id);
        if (fileIndex !== -1) db.files.splice(fileIndex, 1);
        db.pending_deletes[delIndex].status = 'approved';
        db.pending_deletes[delIndex].reviewed_at = new Date().toISOString();
        writeDB(db);
        broadcastFileDeleted(del.file_id);
        res.json({ success: true, message: 'File deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reject-delete/:deleteId', authenticate, requireAdmin, async (req, res) => {
    try {
        const db = readDB();
        const deleteId = req.params.deleteId;
        const delIndex = (db.pending_deletes || []).findIndex(d => d.id === deleteId && d.status === 'pending');
        if (delIndex === -1) return res.status(404).json({ error: 'Delete request not found' });
        db.pending_deletes[delIndex].status = 'rejected';
        db.pending_deletes[delIndex].reject_reason = req.body.reason || 'Ditolak admin';
        db.pending_deletes[delIndex].reviewed_at = new Date().toISOString();
        writeDB(db);
        res.json({ success: true, message: 'Delete rejected' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ REPORT ROUTES ============
app.post('/api/report', authenticate, async (req, res) => {
    const { file_id, reason, description } = req.body;
    const db = readDB();
    db.reports.push({
        id: 'report_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        file_id,
        reported_by: req.user.id,
        reason,
        description: description || '',
        status: 'pending',
        created_at: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true });
});

app.get('/api/admin/reports', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const pending = db.reports.filter(r => r.status === 'pending');
    const users = db.users;
    const files = db.files;
    res.json({ reports: pending.map(r => ({ ...r, reporter_name: users.find(u => u.id === r.reported_by)?.username || 'Unknown', file_name: files.find(f => f.id === r.file_id)?.original_name || 'File dihapus' })) });
});

app.post('/api/admin/delete-file/:fileId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const fileIndex = db.files.findIndex(f => f.id === req.params.fileId);
    if (fileIndex !== -1) {
        const file = db.files[fileIndex];
        const filePath = path.join(__dirname, file.stored_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        db.files.splice(fileIndex, 1);
        writeDB(db);
        broadcastFileDeleted(req.params.fileId);
    }
    res.json({ success: true });
});

app.post('/api/admin/ignore-report/:reportId', authenticate, requireAdmin, async (req, res) => {
    const db = readDB();
    const repIndex = db.reports.findIndex(r => r.id === req.params.reportId);
    if (repIndex !== -1) {
        db.reports[repIndex].status = 'ignored';
        writeDB(db);
    }
    res.json({ success: true });
});

// ============ STATS ============
app.get('/api/stats', async (req, res) => {
    const db = readDB();
    res.json({
        total_files: db.files.length,
        total_downloads: db.files.reduce((sum, f) => sum + (f.download_count || 0), 0),
        total_users: db.users.filter(u => u.username !== 'admin').length
    });
});

// ============ SERVE FRONTEND ============
app.use(express.static('public'));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============
initDatabase();
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔐 Admin: admin / admin123\n`);
});