// Tambahkan di awal script, setelah variabel global
// ============ SOCKET.IO REAL-TIME ============
let socket = null;

function initSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('🔌 Connected to server');
        if (currentUser) {
            socket.emit('register-user', currentUser.id);
        }
    });
    
    // Listen untuk file baru
    socket.on('new-file', (file) => {
        console.log('📢 New file received:', file.original_name);
        showToast(`📢 File baru: ${file.original_name} telah ditambahkan!`);
        // Refresh files tanpa reload page
        refreshFiles();
    });
    
    // Listen untuk file dihapus
    socket.on('file-deleted', (fileId) => {
        console.log('📢 File deleted:', fileId);
        showToast(`🗑️ Sebuah file telah dihapus`);
        refreshFiles();
    });
    
    // Listen untuk file diupdate
    socket.on('file-updated', (data) => {
        console.log('📢 File updated:', data.id);
        refreshFiles();
    });
    
    socket.on('disconnect', () => {
        console.log('🔌 Disconnected from server');
    });
}

function refreshFiles() {
    // Refresh daftar file tanpa reload halaman
    loadFiles();
    loadStats();
}

// Panggil initSocket saat halaman dimuat
// Ganti di bagian initialize:
// updateUI();
// loadFiles();
// loadStats();
// initSocket(); // Tambahkan ini