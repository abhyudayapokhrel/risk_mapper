const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'mobile');
if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Mobile directory removed');
} else {
    console.log('Mobile directory not found');
}
