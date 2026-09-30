$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin = Join-Path $Root 'bin'

if (-not (Test-Path -LiteralPath $Bin)) {
    New-Item -ItemType Directory -Path $Bin | Out-Null
}

Write-Host "Instalando herramientas en $Bin" -ForegroundColor Cyan
Write-Host ""

# --- yt-dlp -----------------------------------------------------------------
$yt = Join-Path $Bin 'yt-dlp.exe'
if (Test-Path -LiteralPath $yt) {
    Write-Host "[ok] yt-dlp ya existe" -ForegroundColor Green
} else {
    Write-Host "[..] Descargando yt-dlp..."
    $url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $yt -UseBasicParsing
    Write-Host "[ok] yt-dlp instalado" -ForegroundColor Green
}

# --- ffmpeg -----------------------------------------------------------------
$ff = Join-Path $Bin 'ffmpeg.exe'
if (Test-Path -LiteralPath $ff) {
    Write-Host "[ok] ffmpeg ya existe" -ForegroundColor Green
} elseif (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Host "[ok] ffmpeg ya esta en el PATH" -ForegroundColor Green
} else {
    Write-Host "[..] Instalando ffmpeg con winget..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    } else {
        Write-Host "     winget no esta disponible. Descarga ffmpeg de https://www.gyan.dev/ffmpeg/builds/ y copia ffmpeg.exe en $Bin" -ForegroundColor Yellow
    }
}

# --- verificar --------------------------------------------------------------
Write-Host ""
& $yt --version
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    ffmpeg -version | Select-Object -First 1
} elseif (Test-Path -LiteralPath $ff) {
    Write-Host "ffmpeg disponible en $ff"
}

Write-Host ""
Write-Host "Listo. Ahora ejecuta:  node server.js" -ForegroundColor Cyan
Write-Host "y abre http://127.0.0.1:3000" -ForegroundColor Cyan
