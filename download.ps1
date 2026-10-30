param(
    [Parameter(Position = 0, Mandatory = $true)]
    [string]$Url,

    [Parameter(Position = 1)]
    [ValidateSet('mp4', 'gif')]
    [string]$Format = 'mp4'
)

$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDirectory

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치해 주세요.'
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectDirectory 'node_modules'))) {
    Write-Host '최초 실행에 필요한 다운로드 도구를 설치합니다...' -ForegroundColor Cyan
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        throw '필요한 도구 설치에 실패했습니다.'
    }
}

& node (Join-Path $ProjectDirectory 'download.js') $Url $Format
exit $LASTEXITCODE
