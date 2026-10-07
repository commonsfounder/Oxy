// Trains Adam's household sound model with Create ML from the folders prepare.py builds, and scores it on the
// held-out test folder.
//
//   swiftc -O test/dev/sound-eval/train/train.swift -o /tmp/sound-train
//   /tmp/sound-train <prepared folder> <output .mlmodel>
import CreateML
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])

let parameters = MLSoundClassifier.ModelParameters(
    validation: .dataSource(.labeledDirectories(at: root.appendingPathComponent("val"))),
    maxIterations: 100,
    overlapFactor: 0.5
)
let started = Date()
let model = try MLSoundClassifier(trainingData: .labeledDirectories(at: root.appendingPathComponent("train")), parameters: parameters)
print("trained in \(Int(Date().timeIntervalSince(started))) s")
print("training accuracy \(String(format: "%.3f", 1 - model.trainingMetrics.classificationError))")
print("validation accuracy \(String(format: "%.3f", 1 - model.validationMetrics.classificationError))")

let test = model.evaluation(on: .labeledDirectories(at: root.appendingPathComponent("test")))
print("test accuracy \(String(format: "%.3f", 1 - test.classificationError))")
print(test.confusion)
print(test.precisionRecall)

try model.write(to: output, metadata: MLModelMetadata(
    author: "Adam",
    shortDescription: "Household sounds: glass breaking, knock, doorbell, baby crying, background.",
    license: "Trained on FSD50K CC0/CC BY clips (Freesound, attribution list in FSD50K metadata) and Donate-a-Cry (ODbL)."
))
print("saved \(output.path)")
