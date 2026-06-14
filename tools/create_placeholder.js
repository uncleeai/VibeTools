/**
 * Create placeholder file for drag & drop
 * This is a helper script to create a minimal placeholder
 */

const fs = require('fs');
const path = require('path');

// Minimal 1x1 pixel transparent PNG in base64
const transparentPNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);

const outputPath = path.join(__dirname, '..', 'support_files', 'vt_placeholder.png');

try {
    fs.writeFileSync(outputPath, transparentPNG);
    console.log('Created placeholder at:', outputPath);
} catch (e) {
    console.error('Error creating placeholder:', e);
}
