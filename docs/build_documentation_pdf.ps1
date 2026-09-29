# Обновляет оглавление в docs/documentation.docx и сохраняет рядом PDF. Нужен Microsoft Word.
# Запуск из корня репозитория: powershell -File docs/build_documentation_pdf.ps1
$docx = (Resolve-Path "docs/documentation.docx").Path
$pdf = [IO.Path]::ChangeExtension($docx, ".pdf")
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
    $doc = $word.Documents.Open($docx)
    $doc.Fields.Update() | Out-Null
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
    $doc.Save()
    $doc.ExportAsFixedFormat($pdf, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1)
    $doc.Close()
} finally {
    $word.Quit()
}
Write-Output $pdf
