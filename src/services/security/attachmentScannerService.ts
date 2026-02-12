import crypto from 'crypto';
import logger from '../../utils/logger';
import { getCollection } from '../../db';

// ─── Types ──────────────────────────────────────────────────────────────────
interface ScanResult {
  safe: boolean;
  threats: string[];
  scan_method: 'clamav' | 'heuristic' | 'skipped';
  scan_time_ms: number;
  file_hash?: string;
}

interface ThreatRecord {
  _id?: string;
  file_hash: string;
  threat_name: string;
  detected_at: Date;
  source: string;
  org_id?: string;
  filename?: string;
  mime_type?: string;
}

// ─── Dangerous file types ───────────────────────────────────────────────────
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'msi', 'msp', 'mst', 'cpl', 'hta', 'inf', 'ins', 'isp',
  'lnk', 'reg', 'rgs', 'sct', 'shb', 'shs', 'ws', 'wsc', 'ps1', 'psm1',
  'psd1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'dll', 'sys', 'drv',
]);

const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-sh',
  'application/x-shellscript',
  'application/vnd.microsoft.portable-executable',
  'application/x-ms-shortcut',
]);

// ─── Magic bytes for dangerous file types ───────────────────────────────────
const DANGEROUS_MAGIC_BYTES: Array<{ bytes: number[]; name: string }> = [
  { bytes: [0x4D, 0x5A], name: 'PE executable (MZ header)' },
  { bytes: [0x7F, 0x45, 0x4C, 0x46], name: 'ELF executable' },
  { bytes: [0x23, 0x21], name: 'Script with shebang (#!)' },
  { bytes: [0xCA, 0xFE, 0xBA, 0xBE], name: 'Mach-O executable' },
  { bytes: [0xFE, 0xED, 0xFA, 0xCE], name: 'Mach-O 32-bit' },
  { bytes: [0xFE, 0xED, 0xFA, 0xCF], name: 'Mach-O 64-bit' },
];

// ─── ClamAV TCP client ──────────────────────────────────────────────────────
const CLAMAV_HOST = process.env.CLAMAV_HOST || '';
const CLAMAV_PORT = parseInt(process.env.CLAMAV_PORT || '3310', 10);
const CLAMAV_TIMEOUT = parseInt(process.env.CLAMAV_TIMEOUT || '30000', 10);

const scanWithClamAV = async (buffer: Buffer): Promise<ScanResult | null> => {
  if (!CLAMAV_HOST) return null;

  const net = await import('net');

  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    let response = '';

    const timeout = setTimeout(() => {
      socket.destroy();
      logger.warn('ClamAV scan timed out');
      resolve(null);
    }, CLAMAV_TIMEOUT);

    socket.connect(CLAMAV_PORT, CLAMAV_HOST, () => {
      // Use INSTREAM command for streaming scan
      const header = Buffer.alloc(4);
      header.writeUInt32BE(buffer.length, 0);

      socket.write('zINSTREAM\0');
      socket.write(header);
      socket.write(buffer);
      // End of stream marker (zero-length chunk)
      const end = Buffer.alloc(4);
      end.writeUInt32BE(0, 0);
      socket.write(end);
    });

    socket.on('data', (data: Buffer) => {
      response += data.toString();
    });

    socket.on('end', () => {
      clearTimeout(timeout);
      const scanTime = Date.now() - startTime;

      // ClamAV response format: "stream: OK" or "stream: <virus_name> FOUND"
      const trimmed = response.trim();
      if (trimmed.includes('OK')) {
        resolve({
          safe: true,
          threats: [],
          scan_method: 'clamav',
          scan_time_ms: scanTime,
        });
      } else if (trimmed.includes('FOUND')) {
        const match = trimmed.match(/stream:\s*(.+?)\s*FOUND/);
        const threatName = match ? match[1] : 'Unknown threat';
        resolve({
          safe: false,
          threats: [threatName],
          scan_method: 'clamav',
          scan_time_ms: scanTime,
        });
      } else {
        logger.warn('Unexpected ClamAV response', { response: trimmed });
        resolve(null);
      }
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timeout);
      logger.warn('ClamAV connection error', { error: err.message });
      resolve(null);
    });
  });
};

// ─── Heuristic scanning ─────────────────────────────────────────────────────
const heuristicScan = (
  buffer: Buffer,
  filename: string,
  mimeType: string
): ScanResult => {
  const startTime = Date.now();
  const threats: string[] = [];

  // 1. Check file extension
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (BLOCKED_EXTENSIONS.has(ext)) {
    threats.push(`Blocked file extension: .${ext}`);
  }

  // 2. Check double extensions (e.g., invoice.pdf.exe)
  const parts = filename.split('.');
  if (parts.length >= 3) {
    const secondToLast = parts[parts.length - 2]?.toLowerCase() || '';
    if (BLOCKED_EXTENSIONS.has(secondToLast)) {
      threats.push(`Suspicious double extension: .${secondToLast}.${ext}`);
    }
  }

  // 3. Check MIME type
  if (BLOCKED_MIME_TYPES.has(mimeType)) {
    threats.push(`Blocked MIME type: ${mimeType}`);
  }

  // 4. Check magic bytes
  if (buffer.length >= 4) {
    for (const { bytes, name } of DANGEROUS_MAGIC_BYTES) {
      let matches = true;
      for (let i = 0; i < bytes.length && i < buffer.length; i++) {
        if (buffer[i] !== bytes[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        threats.push(`Dangerous file type detected: ${name}`);
        break;
      }
    }
  }

  // 5. Check for embedded VBA macros in Office files
  const officeExtensions = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'docm', 'xlsm', 'pptm'];
  if (officeExtensions.includes(ext)) {
    const content = buffer.toString('latin1');
    if (content.includes('VBA') || content.includes('ThisDocument') || content.includes('Auto_Open')) {
      threats.push('Potential VBA macro detected in Office document');
    }
  }

  // 6. Check for archive bombs (suspicious compression ratios)
  const zipExtensions = ['zip', 'gz', 'tar', 'rar', '7z'];
  if (zipExtensions.includes(ext) && buffer.length < 1000 && filename.includes('.')) {
    // Very small archive files are suspicious
    threats.push('Suspiciously small archive file');
  }

  return {
    safe: threats.length === 0,
    threats,
    scan_method: 'heuristic',
    scan_time_ms: Date.now() - startTime,
  };
};

// ─── Known threat hash database ─────────────────────────────────────────────
const checkKnownThreats = async (fileHash: string): Promise<string | null> => {
  const collection = await getCollection<ThreatRecord>('known_threats');
  if (!collection) return null;

  const threat = await collection.findOne({ file_hash: fileHash });
  return threat ? threat.threat_name : null;
};

const recordThreat = async (
  fileHash: string,
  threatName: string,
  source: string,
  orgId?: string,
  filename?: string,
  mimeType?: string
): Promise<void> => {
  const collection = await getCollection<ThreatRecord>('known_threats');
  if (!collection) return;

  await collection.updateOne(
    { file_hash: fileHash },
    {
      $set: {
        threat_name: threatName,
        detected_at: new Date(),
        source,
        org_id: orgId,
        filename,
        mime_type: mimeType,
      },
    },
    { upsert: true }
  );
};

// ─── Public API ─────────────────────────────────────────────────────────────
export class AttachmentScannerService {
  private static instance: AttachmentScannerService;

  private constructor() {}

  public static getInstance(): AttachmentScannerService {
    if (!AttachmentScannerService.instance) {
      AttachmentScannerService.instance = new AttachmentScannerService();
    }
    return AttachmentScannerService.instance;
  }

  /**
   * Scan an attachment buffer for threats.
   * Uses ClamAV if available, otherwise falls back to heuristic scanning.
   * Also checks against known threat hashes.
   */
  public async scanAttachment(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    orgId?: string
  ): Promise<ScanResult> {
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // 1. Check known threat hashes first (fast path)
    const knownThreat = await checkKnownThreats(fileHash);
    if (knownThreat) {
      logger.warn('Known threat detected by hash', { fileHash, threatName: knownThreat, filename });
      return {
        safe: false,
        threats: [`Known threat: ${knownThreat}`],
        scan_method: 'heuristic',
        scan_time_ms: 0,
        file_hash: fileHash,
      };
    }

    // 2. Try ClamAV scan
    const clamResult = await scanWithClamAV(buffer);
    if (clamResult) {
      clamResult.file_hash = fileHash;
      if (!clamResult.safe) {
        // Record the threat for future fast lookups
        await recordThreat(
          fileHash,
          clamResult.threats.join(', '),
          'clamav',
          orgId,
          filename,
          mimeType
        );
        logger.warn('ClamAV threat detected', { filename, threats: clamResult.threats });
      }
      return clamResult;
    }

    // 3. Fallback to heuristic scanning
    const heuristicResult = heuristicScan(buffer, filename, mimeType);
    heuristicResult.file_hash = fileHash;

    if (!heuristicResult.safe) {
      await recordThreat(
        fileHash,
        heuristicResult.threats.join(', '),
        'heuristic',
        orgId,
        filename,
        mimeType
      );
      logger.warn('Heuristic threat detected', { filename, threats: heuristicResult.threats });
    }

    return heuristicResult;
  }

  /**
   * Initialize the known_threats collection indexes.
   */
  public async ensureIndexes(): Promise<void> {
    const collection = await getCollection<ThreatRecord>('known_threats');
    if (collection) {
      await collection.createIndex({ file_hash: 1 }, { unique: true });
      await collection.createIndex({ detected_at: -1 });
      await collection.createIndex({ source: 1 });
    }
  }
}
