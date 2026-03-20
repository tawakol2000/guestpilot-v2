#!/usr/bin/env python3
"""
LR Classifier Training Script for GuestPilot.

Reads training examples from stdin as JSON, embeds with Cohere,
trains OneVsRestClassifier(LogisticRegression), runs 5-fold
cross-validation, computes centroids and per-category thresholds,
and writes classifier-weights.json.

T016: Supports description-enhanced training (1044-dim augmented vectors)
when descriptions are provided in the input.

Usage:
  echo '{"examples": [...], "cohereApiKey": "...", "descriptions": {...}}' | python3 train_classifier.py --output ./classifier-weights.json
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
    """Embed texts using Cohere API (ClientV2 for embed-v4.0 + output_dimension)."""
    import cohere
    co = cohere.ClientV2(api_key)
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i+batch_size]
        response = co.embed(
            texts=batch,
            model="embed-v4.0",
            input_type=input_type,
            embedding_types=["float"],
            output_dimension=1024
        )
        all_embeddings.extend(response.embeddings.float)
        if i + batch_size < len(texts):
            time.sleep(0.1)  # Rate limit courtesy
    return np.array(all_embeddings)


def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    return dot / (norm_a * norm_b + 1e-10)


def compute_description_similarities(query_embedding, desc_embeddings, desc_categories):
    """Compute per-category max cosine similarity against description embeddings.
    Returns a feature vector of length len(desc_categories) in alphabetical order."""
    features = []
    for cat in desc_categories:
        embs = desc_embeddings.get(cat, [])
        if not embs:
            features.append(0.0)
            continue
        max_sim = max(cosine_similarity(query_embedding, emb) for emb in embs)
        features.append(float(max_sim))
    return features


def train_lr(embeddings, label_matrix, mlb):
    """Train OneVsRestClassifier with LogisticRegression.
    Uses StandardScaler internally and absorbs scaling into coefficients
    so inference code needs no scaling step."""
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(embeddings)

    clf = OneVsRestClassifier(
        LogisticRegression(
            max_iter=1000,
            C=1.0,
            solver='lbfgs',
            class_weight='balanced'
        ),
        n_jobs=-1
    )
    clf.fit(X_scaled, label_matrix)

    # Absorb scaling into coefficients: w' = w/std, b' = b - w·mean/std
    for estimator in clf.estimators_:
        w = estimator.coef_[0]           # (n_features,)
        b = estimator.intercept_[0]      # scalar
        adjusted_w = w / scaler.scale_
        adjusted_b = b - np.dot(w, scaler.mean_ / scaler.scale_)
        estimator.coef_[0] = adjusted_w
        estimator.intercept_[0] = adjusted_b

    return clf


def cross_validate(embeddings, label_matrix, mlb, n_folds=5):
    """K-fold cross-validation. Much faster and less memory than LOO-CV.
    Uses cached embeddings (no extra API calls)."""
    from sklearn.model_selection import KFold
    n = len(embeddings)
    correct = 0
    total_tested = 0
    per_category_correct = defaultdict(int)
    per_category_total = defaultdict(int)
    confidences_per_category = defaultdict(list)

    kf = KFold(n_splits=min(n_folds, n), shuffle=True, random_state=42)

    for train_idx, test_idx in kf.split(embeddings):
        X_train = embeddings[train_idx]
        y_train = label_matrix[train_idx]
        X_test = embeddings[test_idx]
        y_test = label_matrix[test_idx]

        from sklearn.preprocessing import StandardScaler
        fold_scaler = StandardScaler()
        X_train_scaled = fold_scaler.fit_transform(X_train)
        X_test_scaled = fold_scaler.transform(X_test)

        clf = OneVsRestClassifier(
            LogisticRegression(max_iter=500, C=1.0, solver='lbfgs', class_weight='balanced'),
            n_jobs=-1
        )
        clf.fit(X_train_scaled, y_train)

        y_pred = clf.predict(X_test_scaled)
        proba = clf.predict_proba(X_test_scaled) if hasattr(clf, 'predict_proba') else None

        for j in range(len(test_idx)):
            true_labels = set(np.where(y_test[j] == 1)[0])
            pred_labels = set(np.where(y_pred[j] == 1)[0])

            if true_labels & pred_labels:
                correct += 1
            total_tested += 1

            for label_idx in true_labels:
                label_name = mlb.classes_[label_idx]
                per_category_total[label_name] += 1
                if label_idx in pred_labels:
                    per_category_correct[label_name] += 1
                if proba is not None:
                    confidences_per_category[label_name].append(float(proba[j][label_idx]))

    accuracy = correct / total_tested if total_tested > 0 else 0

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
    descriptions = input_data.get('descriptions')  # T016: optional SOP descriptions

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

    # T016: Embed descriptions and compute augmented features if descriptions provided
    desc_embeddings_output = None
    feature_schema = None
    augmented_embeddings = embeddings  # default: plain 1024-dim

    if descriptions and isinstance(descriptions, dict):
        print(f"[train] Embedding SOP descriptions for description-enhanced LR...", file=sys.stderr)
        desc_categories = sorted(descriptions.keys())

        # Flatten all description texts
        desc_texts = []
        desc_text_map = []  # (category, local_index)
        for cat in desc_categories:
            cat_data = descriptions[cat]
            all_descs = cat_data.get('en', []) + cat_data.get('ar', [])
            for desc in all_descs:
                desc_text_map.append((cat, len(desc_texts)))
                desc_texts.append(desc)

        if desc_texts:
            desc_raw_embeddings = embed_texts(desc_texts, api_key)
            print(f"[train] Embedded {len(desc_texts)} descriptions", file=sys.stderr)

            # Build per-category embedding map
            desc_emb_map = defaultdict(list)
            for (cat, _), emb in zip(desc_text_map, desc_raw_embeddings):
                desc_emb_map[cat].append(emb)

            # Compute description similarities for each training example
            print(f"[train] Computing description similarity features ({len(desc_categories)}-dim)...", file=sys.stderr)
            desc_features = []
            for i in range(len(embeddings)):
                features = compute_description_similarities(
                    embeddings[i], desc_emb_map, desc_categories
                )
                desc_features.append(features)

            desc_features = np.array(desc_features)

            augmented_embeddings = np.concatenate([embeddings, desc_features], axis=1)
            print(f"[train] Augmented vectors: {augmented_embeddings.shape[1]}-dim ({embeddings.shape[1]} + {desc_features.shape[1]})", file=sys.stderr)

            # Build output description embeddings (for runtime cold start)
            desc_embeddings_output = {}
            for cat in desc_categories:
                cat_data = descriptions[cat]
                en_descs = cat_data.get('en', [])
                ar_descs = cat_data.get('ar', [])
                cat_embs = desc_emb_map[cat]
                n_en = len(en_descs)
                desc_embeddings_output[cat] = {
                    "en": [emb.tolist() for emb in cat_embs[:n_en]],
                    "ar": [emb.tolist() for emb in cat_embs[n_en:]]
                }

            feature_schema = {
                "embeddingDim": int(embeddings.shape[1]),
                "descriptionDim": len(desc_categories),
                "totalDim": int(augmented_embeddings.shape[1]),
                "descriptionCategories": desc_categories
            }

    # Prepare multi-label matrix
    mlb = MultiLabelBinarizer()
    label_matrix = mlb.fit_transform(labels_list)
    all_classes = list(mlb.classes_)

    print(f"[train] Training OneVsRestClassifier on {len(all_classes)} classes ({augmented_embeddings.shape[1]}-dim)...", file=sys.stderr)
    clf = train_lr(augmented_embeddings, label_matrix, mlb)
    train_duration = time.time() - start_time - embed_duration

    print(f"[train] Running 5-fold cross-validation...", file=sys.stderr)
    cv_accuracy, per_category_accuracy, confidences_per_category = cross_validate(
        augmented_embeddings, label_matrix, mlb, n_folds=5
    )
    cv_duration = time.time() - start_time - embed_duration - train_duration

    print(f"[train] Computing centroids and thresholds...", file=sys.stderr)
    # Centroids are computed on the raw 1024-dim embeddings (for topic-state centroid distance)
    centroids = compute_centroids(embeddings, labels_list, all_classes)
    per_category_thresholds = compute_thresholds(confidences_per_category)

    # Compute global threshold (median of per-category thresholds)
    if per_category_thresholds:
        global_threshold = float(np.median(list(per_category_thresholds.values())))
    else:
        global_threshold = 0.5

    # Extract weights from the trained classifier
    coefficients = []
    intercepts = []
    for estimator in clf.estimators_:
        coefficients.append(estimator.coef_[0].tolist())
        intercepts.append(float(estimator.intercept_[0]))

    total_duration = time.time() - start_time

    # Build output
    output = {
        "model": "cohere-embed-v4.0",
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

    # T016: Add description embeddings and feature schema if descriptions were used
    if desc_embeddings_output:
        output["descriptionEmbeddings"] = desc_embeddings_output
    if feature_schema:
        output["featureSchema"] = feature_schema

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
        "featureDim": int(augmented_embeddings.shape[1]),
        "descriptionEnhanced": desc_embeddings_output is not None,
        "message": f"Classifier retrained: {len(examples)} examples, {len(all_classes)} classes, {cv_accuracy*100:.1f}% CV accuracy, {augmented_embeddings.shape[1]}-dim features"
    }
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
