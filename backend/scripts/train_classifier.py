#!/usr/bin/env python3
"""
LR Classifier Training Script for GuestPilot.

Reads training examples from stdin as JSON, embeds with Cohere,
trains OneVsRestClassifier(LogisticRegression), runs leave-one-out
cross-validation, computes centroids and per-category thresholds,
and writes classifier-weights.json.

Usage:
  echo '{"examples": [...], "cohereApiKey": "..."}' | python3 train_classifier.py --output ./classifier-weights.json
"""

import sys
import json
import argparse
import time
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.preprocessing import MultiLabelBinarizer
from collections import defaultdict

def embed_texts(texts, api_key, input_type="classification", batch_size=96):
    """Embed texts using Cohere API."""
    import cohere
    co = cohere.Client(api_key)
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i+batch_size]
        response = co.embed(
            texts=batch,
            model="embed-multilingual-v3.0",
            input_type=input_type,
            embedding_types=["float"]
        )
        all_embeddings.extend(response.embeddings.float)
        if i + batch_size < len(texts):
            time.sleep(0.1)  # Rate limit courtesy
    return np.array(all_embeddings)


def train_lr(embeddings, label_matrix, mlb):
    """Train OneVsRestClassifier with LogisticRegression."""
    clf = OneVsRestClassifier(
        LogisticRegression(
            max_iter=1000,
            C=1.0,
            solver='lbfgs',
            class_weight='balanced'
        ),
        n_jobs=-1
    )
    clf.fit(embeddings, label_matrix)
    return clf


def leave_one_out_cv(embeddings, label_matrix, mlb):
    """Leave-one-out cross-validation. Uses cached embeddings (no extra API calls)."""
    n = len(embeddings)
    correct = 0
    per_category_correct = defaultdict(int)
    per_category_total = defaultdict(int)
    confidences_per_category = defaultdict(list)

    for i in range(n):
        # Train on all except i
        train_idx = list(range(0, i)) + list(range(i+1, n))
        X_train = embeddings[train_idx]
        y_train = label_matrix[train_idx]
        X_test = embeddings[i:i+1]
        y_true = label_matrix[i]

        clf = OneVsRestClassifier(
            LogisticRegression(max_iter=500, C=1.0, solver='lbfgs', class_weight='balanced'),
            n_jobs=-1
        )
        clf.fit(X_train, y_train)

        # Predict
        y_pred = clf.predict(X_test)[0]
        proba = clf.predict_proba(X_test)[0] if hasattr(clf, 'predict_proba') else None

        # Check if prediction matches (at least one correct label)
        true_labels = set(np.where(y_true == 1)[0])
        pred_labels = set(np.where(y_pred == 1)[0])

        if true_labels & pred_labels:  # At least one overlap
            correct += 1

        # Per-category tracking
        for label_idx in true_labels:
            label_name = mlb.classes_[label_idx]
            per_category_total[label_name] += 1
            if label_idx in pred_labels:
                per_category_correct[label_name] += 1
            if proba is not None:
                confidences_per_category[label_name].append(float(proba[label_idx]))

    accuracy = correct / n if n > 0 else 0

    per_category_accuracy = {}
    for cat in per_category_total:
        total = per_category_total[cat]
        corr = per_category_correct.get(cat, 0)
        per_category_accuracy[cat] = corr / total if total > 0 else 0

    return accuracy, per_category_accuracy, confidences_per_category


def compute_centroids(embeddings, labels_list, all_classes):
    """Compute mean embedding per category."""
    centroids = {}
    for cls in all_classes:
        indices = [i for i, labels in enumerate(labels_list) if cls in labels]
        if indices:
            centroids[cls] = embeddings[indices].mean(axis=0).tolist()
    return centroids


def compute_thresholds(confidences_per_category):
    """Compute per-category thresholds as mean - 2*std."""
    thresholds = {}
    for cat, confs in confidences_per_category.items():
        if len(confs) >= 2:
            mean = np.mean(confs)
            std = np.std(confs)
            thresholds[cat] = max(0.1, float(mean - 2 * std))
        elif len(confs) == 1:
            thresholds[cat] = max(0.1, float(confs[0] * 0.5))
        else:
            thresholds[cat] = 0.3  # Default
    return thresholds


def main():
    parser = argparse.ArgumentParser(description='Train LR classifier')
    parser.add_argument('--output', default='./src/config/classifier-weights.json',
                        help='Output path for weights JSON')
    args = parser.parse_args()

    # Read input from stdin
    input_data = json.load(sys.stdin)
    examples = input_data['examples']
    api_key = input_data['cohereApiKey']

    if not examples:
        print(json.dumps({"error": "No training examples provided"}))
        sys.exit(1)

    start_time = time.time()

    # Extract texts and labels
    texts = [ex['text'] for ex in examples]
    labels_list = [ex['labels'] for ex in examples]

    print(f"[train] Embedding {len(texts)} examples with Cohere...", file=sys.stderr)
    embeddings = embed_texts(texts, api_key)
    embed_duration = time.time() - start_time
    print(f"[train] Embedded in {embed_duration:.1f}s", file=sys.stderr)

    # Prepare multi-label matrix
    mlb = MultiLabelBinarizer()
    label_matrix = mlb.fit_transform(labels_list)
    all_classes = list(mlb.classes_)

    print(f"[train] Training OneVsRestClassifier on {len(all_classes)} classes...", file=sys.stderr)
    clf = train_lr(embeddings, label_matrix, mlb)
    train_duration = time.time() - start_time - embed_duration

    print(f"[train] Running leave-one-out cross-validation...", file=sys.stderr)
    cv_accuracy, per_category_accuracy, confidences_per_category = leave_one_out_cv(
        embeddings, label_matrix, mlb
    )
    cv_duration = time.time() - start_time - embed_duration - train_duration

    print(f"[train] Computing centroids and thresholds...", file=sys.stderr)
    centroids = compute_centroids(embeddings, labels_list, all_classes)
    per_category_thresholds = compute_thresholds(confidences_per_category)

    # Compute global threshold (median of per-category thresholds)
    if per_category_thresholds:
        global_threshold = float(np.median(list(per_category_thresholds.values())))
    else:
        global_threshold = 0.5

    # Extract weights from the trained classifier
    # OneVsRestClassifier wraps individual LogisticRegression estimators
    coefficients = []
    intercepts = []
    for estimator in clf.estimators_:
        coefficients.append(estimator.coef_[0].tolist())
        intercepts.append(float(estimator.intercept_[0]))

    total_duration = time.time() - start_time

    # Build output
    output = {
        "model": "cohere-embed-multilingual-v3.0",
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "exampleCount": len(examples),
        "embeddingDim": int(embeddings.shape[1]),
        "classes": all_classes,
        "coefficients": coefficients,
        "intercepts": intercepts,
        "centroids": centroids,
        "thresholds": {
            "global": global_threshold,
            "perCategory": per_category_thresholds
        },
        "calibration": {
            "crossValAccuracy": round(cv_accuracy, 4),
            "perCategoryAccuracy": {k: round(v, 4) for k, v in per_category_accuracy.items()}
        },
        "timing": {
            "embedMs": int(embed_duration * 1000),
            "trainMs": int(train_duration * 1000),
            "cvMs": int(cv_duration * 1000),
            "totalMs": int(total_duration * 1000)
        }
    }

    # Write to file
    with open(args.output, 'w') as f:
        json.dump(output, f, indent=2)

    # Print summary to stdout (Node.js reads this)
    summary = {
        "success": True,
        "exampleCount": len(examples),
        "classes": len(all_classes),
        "crossValAccuracy": round(cv_accuracy, 4),
        "globalThreshold": round(global_threshold, 4),
        "trainDurationMs": int(total_duration * 1000),
        "message": f"Classifier retrained: {len(examples)} examples, {len(all_classes)} classes, {cv_accuracy*100:.1f}% CV accuracy"
    }
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
