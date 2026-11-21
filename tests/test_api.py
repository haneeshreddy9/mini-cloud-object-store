
import hashlib
import unittest

import httpx


BASE_URL = "http://localhost:8000"


class ObjectStoreAPITests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = httpx.Client(
            base_url=BASE_URL,
            timeout=30.0
        )

        response = cls.client.get("/health")
        response.raise_for_status()

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_complete_object_lifecycle(self):

        # 1. Generate test data
        original_data = bytes(range(256)) * 8192
        original_checksum = hashlib.sha256(
            original_data
        ).hexdigest()

        # 2. Upload object
        upload_response = self.client.post(
            "/api/v1/objects",
            files={
                "file": (
                    "automated_test.bin",
                    original_data,
                    "application/octet-stream"
                )
            }
        )

        self.assertEqual(upload_response.status_code, 200)

        upload_result = upload_response.json()

        object_id = upload_result["object_id"]

        self.assertEqual(
            upload_result["replication_factor"], 2
        )

        self.assertGreater(
            upload_result["number_of_chunks"], 0
        )

        # Verify that each chunk has distinct primary
        # and replica Workers.
        for chunk in upload_result["chunks"]:
            self.assertNotEqual(
                chunk["worker_id"],
                chunk["replica_worker_id"]
            )

        # 3. Verify object listing
        list_response = self.client.get(
            "/api/v1/objects"
        )

        self.assertEqual(list_response.status_code, 200)

        listed_ids = [
            obj["object_id"]
            for obj in list_response.json()["objects"]
        ]

        self.assertIn(object_id, listed_ids)

        # 4. Update custom metadata
        metadata_response = self.client.put(
            f"/api/v1/objects/{object_id}/metadata",
            json={
                "metadata": {
                    "test": "automated",
                    "purpose": "API validation"
                }
            }
        )

        self.assertEqual(metadata_response.status_code, 200)

        # 5. Retrieve and verify metadata
        get_metadata_response = self.client.get(
            f"/api/v1/objects/{object_id}/metadata"
        )

        self.assertEqual(
            get_metadata_response.status_code, 200
        )

        metadata = get_metadata_response.json()["custom_metadata"]

        self.assertEqual(metadata["test"], "automated")
        self.assertEqual(metadata["purpose"], "API validation")

        # 6. Download object
        download_response = self.client.get(
            f"/api/v1/objects/{object_id}"
        )

        self.assertEqual(download_response.status_code, 200)

        downloaded_data = download_response.content

        downloaded_checksum = hashlib.sha256(
            downloaded_data
        ).hexdigest()

        self.assertEqual(
            original_checksum,
            downloaded_checksum
        )

        self.assertEqual(original_data, downloaded_data)

        # 7. Delete object
        delete_response = self.client.delete(
            f"/api/v1/objects/{object_id}"
        )

        self.assertEqual(delete_response.status_code, 200)

        # 8. Verify object no longer exists
        missing_response = self.client.get(
            f"/api/v1/objects/{object_id}"
        )

        self.assertEqual(missing_response.status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
