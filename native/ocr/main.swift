// mobhub-ocr: read a PNG from stdin, find the text and the codes (QR, barcodes) in it with Apple Vision,
// write JSON to stdout.
//
// Usage: mobhub-ocr [--region x,y,w,h]
//   --region  Part of the image to read, as fractions (0...1) of the image size, origin at top left.
//
// Output: {"width":W,"height":H,"lines":[{"text":"...","x":0.1,"y":0.2,"w":0.5,"h":0.03}, ...],
//          "codes":[{"type":"QR","payload":"...","x":0.1,"y":0.2,"w":0.5,"h":0.3}, ...]}
//   Each box is a fraction of the image that was read (the region, if one was given), origin at top left.
//   Codes without a text payload (binary data) are not in the output.

import CoreGraphics
import Foundation
import ImageIO
import Vision

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

var region: CGRect?
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
  guard arg == "--region", let value = args.popFirst() else { fail("Unknown argument: \(arg)") }
  let n = value.split(separator: ",").compactMap { Double($0) }
  guard n.count == 4, n.allSatisfy({ $0 >= 0 && $0 <= 1 }), n[2] > 0, n[3] > 0 else { fail("Bad region: \(value)") }
  region = CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(input as CFData, nil),
  var image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else { fail("The input is not an image") }

if let r = region {
  let w = Double(image.width), h = Double(image.height)
  let crop = CGRect(x: r.minX * w, y: r.minY * h, width: r.width * w, height: r.height * h).integral
  guard let cropped = image.cropping(to: crop) else { fail("The region is outside the image") }
  image = cropped
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
// Vietnamese first. Use only the languages that this macOS version supports.
let supported = (try? request.supportedRecognitionLanguages()) ?? ["en-US"]
let wanted = ["vi-VT", "en-US"].filter { supported.contains($0) }
request.recognitionLanguages = wanted.isEmpty ? ["en-US"] : wanted

let codesRequest = VNDetectBarcodesRequest()

do {
  try VNImageRequestHandler(cgImage: image).perform([request, codesRequest])
} catch {
  fail("Text recognition failed: \(error.localizedDescription)")
}

// Vision boxes have their origin at the bottom left. Flip them to the top left.
let lines: [[String: Any]] = (request.results ?? []).compactMap { o in
  guard let text = o.topCandidates(1).first?.string else { return nil }
  let b = o.boundingBox
  return ["text": text, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height]
}
let codes: [[String: Any]] = (codesRequest.results ?? []).compactMap { o in
  guard let payload = o.payloadStringValue else { return nil }
  let b = o.boundingBox
  let type = o.symbology.rawValue.replacingOccurrences(of: "VNBarcodeSymbology", with: "")
  return ["type": type, "payload": payload, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height]
}
let output: [String: Any] = ["width": image.width, "height": image.height, "lines": lines, "codes": codes]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: output))
