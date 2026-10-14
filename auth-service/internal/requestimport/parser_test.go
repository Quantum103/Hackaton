package requestimport

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestFallbackParsesPipeSeparatedRows(t *testing.T) {
	document := Fallback("Товар | Количество | Единица\nМолоко | 2 | л\nСахар | 500 | г")
	if len(document.Items) != 2 {
		t.Fatalf("expected 2 items, got %d: %#v", len(document.Items), document.Items)
	}
	if document.Items[0].ProductName != "Молоко" || document.Items[0].Quantity != 2 || document.Items[0].Unit != "l" {
		t.Fatalf("unexpected first item: %#v", document.Items[0])
	}
	if document.Items[1].ProductName != "Сахар" || document.Items[1].Quantity != 500 || document.Items[1].Unit != "g" {
		t.Fatalf("unexpected second item: %#v", document.Items[1])
	}
}

func TestConvertQuantity(t *testing.T) {
	got, ok := ConvertQuantity(2.5, "kg", "g")
	if !ok || got != 2500 {
		t.Fatalf("expected 2500 g, got %v (ok=%v)", got, ok)
	}
	got, ok = ConvertQuantity(1.5, "l", "ml")
	if !ok || got != 1500 {
		t.Fatalf("expected 1500 ml, got %v (ok=%v)", got, ok)
	}
	if _, ok := ConvertQuantity(1, "pcs", "g"); ok {
		t.Fatal("pcs cannot be converted to grams")
	}
}

func TestExtractXLSX(t *testing.T) {
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	part, err := writer.Create("xl/worksheets/sheet1.xml")
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.WriteString(part, `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Товар</t></is></c><c r="B1" t="inlineStr"><is><t>Количество</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Рис</t></is></c><c r="B2"><v>12</v></c></row>
  </sheetData>
</worksheet>`)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	text, err := extractXLSX(data.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Товар	Количество") || !strings.Contains(text, "Рис	12") {
		t.Fatalf("unexpected extracted workbook text: %q", text)
	}
}

func TestExtractPDFTextLayer(t *testing.T) {
	newline := string([]byte{10})
	pdf := []byte("%PDF-1.4" + newline + "1 0 obj" + newline + "<< /Length 25 >>" + newline + "stream" + newline + "(Milk 2 L) Tj" + newline + "endstream" + newline + "endobj" + newline + "%%EOF")
	text, err := extractPDF(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Milk 2 L") {
		t.Fatalf("expected PDF text, got %q", text)
	}
}
