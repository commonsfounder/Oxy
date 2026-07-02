const crypto = require('crypto');
const archiver = require('archiver');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const execFileAsync = promisify(execFile);

const SUPPORTED_ACTIONS = ['add_to_wallet'];

// Required env vars (all blocked until paid Apple Developer account):
//   WALLET_PASS_TYPE_ID  e.g. pass.com.yourapp.trip
//   WALLET_TEAM_ID       10-char Apple Team ID
//   WALLET_CERT          PEM content of Pass Type ID signing cert
//   WALLET_KEY           PEM content of private key
//   WALLET_WWDR_CERT     PEM content of Apple WWDR G4 intermediate cert

function walletConfigured() {
  return !!(
    process.env.WALLET_PASS_TYPE_ID &&
    process.env.WALLET_TEAM_ID &&
    process.env.WALLET_CERT &&
    process.env.WALLET_KEY &&
    process.env.WALLET_WWDR_CERT
  );
}

/**
 * Build pass.json content for a given booking.
 * `booking` shape:
 *   { type: 'train'|'flight'|'event'|'generic', description, origin, destination,
 *     departs, arrives, date, carrier, reference }
 */
function buildPassJson(booking, serialNumber) {
  const base = {
    formatVersion: 1,
    passTypeIdentifier: process.env.WALLET_PASS_TYPE_ID,
    serialNumber,
    teamIdentifier: process.env.WALLET_TEAM_ID,
    organizationName: 'Oxy',
    description: booking.description || 'Trip',
    backgroundColor: 'rgb(250,249,246)',
    foregroundColor: 'rgb(30,30,30)',
    labelColor: 'rgb(120,110,100)'
  };

  const type = (booking.type || 'generic').toLowerCase();

  if (type === 'train') {
    return {
      ...base,
      boardingPass: {
        transitType: 'PKTransitTypeTrain',
        primaryFields: [
          { key: 'origin', label: 'FROM', value: booking.origin || '' },
          { key: 'destination', label: 'TO', value: booking.destination || '' }
        ],
        secondaryFields: [
          booking.departs ? { key: 'departs', label: 'DEPARTS', value: booking.departs } : null,
          booking.arrives ? { key: 'arrives', label: 'ARRIVES', value: booking.arrives } : null
        ].filter(Boolean),
        auxiliaryFields: [
          booking.date ? { key: 'date', label: 'DATE', value: booking.date } : null,
          booking.carrier ? { key: 'carrier', label: 'OPERATOR', value: booking.carrier } : null,
          booking.reference ? { key: 'ref', label: 'REFERENCE', value: booking.reference } : null
        ].filter(Boolean)
      }
    };
  }

  if (type === 'flight') {
    return {
      ...base,
      boardingPass: {
        transitType: 'PKTransitTypeAir',
        primaryFields: [
          { key: 'origin', label: booking.originCode || 'FROM', value: booking.origin || '' },
          { key: 'destination', label: booking.destinationCode || 'TO', value: booking.destination || '' }
        ],
        secondaryFields: [
          booking.departs ? { key: 'departs', label: 'DEPARTS', value: booking.departs } : null,
          booking.arrives ? { key: 'arrives', label: 'ARRIVES', value: booking.arrives } : null
        ].filter(Boolean),
        auxiliaryFields: [
          booking.date ? { key: 'date', label: 'DATE', value: booking.date } : null,
          booking.carrier ? { key: 'flight', label: 'FLIGHT', value: booking.carrier } : null,
          booking.reference ? { key: 'ref', label: 'BOOKING REF', value: booking.reference } : null
        ].filter(Boolean)
      }
    };
  }

  // Generic / event
  return {
    ...base,
    generic: {
      primaryFields: [
        { key: 'title', label: 'EVENT', value: booking.description || '' }
      ],
      secondaryFields: [
        booking.origin ? { key: 'location', label: 'LOCATION', value: booking.origin } : null,
        booking.date ? { key: 'date', label: 'DATE', value: booking.date } : null
      ].filter(Boolean),
      auxiliaryFields: [
        booking.departs ? { key: 'time', label: 'TIME', value: booking.departs } : null,
        booking.reference ? { key: 'ref', label: 'REFERENCE', value: booking.reference } : null
      ].filter(Boolean)
    }
  };
}

/**
 * Generate a .pkpass archive and return it as a Buffer.
 * Uses openssl for PKCS7 signing (available on macOS/Linux).
 */
async function generatePkpass(booking) {
  const serialNumber = `oxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const passJson = JSON.stringify(buildPassJson(booking, serialNumber));
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pass-'));

  try {
    // Write cert/key files
    const certPath = path.join(tmpDir, 'signer.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    const wwdrPath = path.join(tmpDir, 'wwdr.pem');
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const signaturePath = path.join(tmpDir, 'signature');

    await Promise.all([
      fs.promises.writeFile(certPath, process.env.WALLET_CERT),
      fs.promises.writeFile(keyPath, process.env.WALLET_KEY),
      fs.promises.writeFile(wwdrPath, process.env.WALLET_WWDR_CERT)
    ]);

    // Build manifest: SHA1 of every file in the pass
    const files = { 'pass.json': Buffer.from(passJson) };
    const manifest = {};
    for (const [name, buf] of Object.entries(files)) {
      manifest[name] = crypto.createHash('sha1').update(buf).digest('hex');
    }
    const manifestBuf = Buffer.from(JSON.stringify(manifest));
    await fs.promises.writeFile(manifestPath, manifestBuf);
    manifest['manifest.json'] = crypto.createHash('sha1').update(manifestBuf).digest('hex');

    // PKCS7 detached signature via openssl
    await execFileAsync('openssl', [
      'smime', '-binary', '-sign',
      '-certfile', wwdrPath,
      '-signer', certPath,
      '-inkey', keyPath,
      '-in', manifestPath,
      '-out', signaturePath,
      '-outform', 'DER'
    ]);

    // Zip everything into a .pkpass
    return await new Promise((resolve, reject) => {
      const chunks = [];
      const passThrough = new PassThrough();
      passThrough.on('data', chunk => chunks.push(chunk));
      passThrough.on('end', () => resolve(Buffer.concat(chunks)));
      passThrough.on('error', reject);

      const archive = archiver('zip');
      archive.on('error', reject);
      archive.pipe(passThrough);

      archive.append(passJson, { name: 'pass.json' });
      archive.append(manifestBuf, { name: 'manifest.json' });
      archive.file(signaturePath, { name: 'signature' });

      archive.finalize();
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

async function execute(userId, action, params) {
  try {
    switch (action) {
      case 'add_to_wallet': {
        if (!walletConfigured()) {
          return {
            success: false,
            error: 'Apple Wallet pass generation requires WALLET_PASS_TYPE_ID, WALLET_TEAM_ID, WALLET_CERT, WALLET_KEY, and WALLET_WWDR_CERT. These need a paid Apple Developer account.'
          };
        }

        const booking = params?.booking;
        if (!booking) {
          return { success: false, error: 'add_to_wallet requires a booking object' };
        }

        const pkpass = await generatePkpass(booking);
        return {
          success: true,
          text: `Pass ready — tap to add "${booking.description || 'trip'}" to Apple Wallet.`,
          cardText: booking.description || 'Trip pass',
          actionSummary: 'Pass ready for Wallet',
          pkpassBase64: pkpass.toString('base64')
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `Wallet error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute, generatePkpass, walletConfigured };
