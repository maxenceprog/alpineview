#pragma once

#include <assert.h>
#include <cmath>

template <typename T>
struct TVec3 {
	
	/* Members */
	T x;
	T y;
	T z;

	/* Constructors */
	constexpr TVec3() = default;
	constexpr TVec3(T x, T y, T z);
	explicit  TVec3(const T* t);

	/* Index Accessor */
	T& operator[] (int n);
	const T& operator[] (int n) const;

	/* Assignement */
	// TVec3& operator= (TVec3 a) {x = a.x; y = a.y; z = a.z; return (*this);}
	/* Equality */
	bool operator== (const TVec3& a) const;

	/* Vector space structure */
	TVec3 operator- () const;
	TVec3& operator+= (const TVec3& a);
	TVec3& operator-= (const TVec3& a);
	TVec3& operator*= (const T& t);
	TVec3& operator/= (const T& t);

	T dot(const TVec3& a) const;
	T length() const;
	TVec3 cross(const TVec3& a, const TVec3& b);
	TVec3 normalize(T desired_length = 1);
	static TVec3 normalize(TVec3 a);

	/* Static members */
	static inline TVec3<T> Zero   {0, 0, 0};
	static inline TVec3<T> XAxis  {1, 0, 0};
	static inline TVec3<T> YAxis  {0, 1, 0};
	static inline TVec3<T> ZAxis  {0, 0, 1};
};

typedef TVec3<float> Vec3;
typedef TVec3<double> Vec3d;

/* Free functions declarations */

template <typename T>
inline TVec3<T> operator+ (const TVec3<T>& a, const TVec3<T>& b);  

template <typename T>
inline TVec3<T> operator- (const TVec3<T>& a, const TVec3<T>& b);  

template <typename T>
inline TVec3<T> operator* (const TVec3<T>& a, const T& t);

template <typename T>
inline TVec3<T> operator* (const T& t, const TVec3<T>& a);

template <typename T>
inline TVec3<T> operator* (const TVec3<T>& a, const TVec3<T>& b);

template <typename T>
inline TVec3<T> operator/ (const TVec3<T>& a, const T& t);

template <typename T>
inline TVec3<T> operator/ (const TVec3<T>& a, const TVec3<T>& b);

template <typename T>
inline T dot(const TVec3<T>& a, const TVec3<T>& b);

template <typename T>
inline TVec3<T> cross(const TVec3<T>& a, const TVec3<T>& b);

template <typename T>
inline T norm(const TVec3<T> a);

template <typename T>
TVec3<T> normalized(const TVec3<T>& a);

template <typename T>
T max(const TVec3<T>& a);

template <typename T>
T min(const TVec3<T>& a);

template <typename T>
TVec3<T> abs(const TVec3<T>& a);

/* Functions implementations */

template <typename T>
inline constexpr TVec3<T>::TVec3(T x, T y, T z): x{x}, y{y}, z{z} {}

template <typename T>
inline TVec3<T>::TVec3(const T* t): x{t[0]}, y{t[1]}, z{t[2]} {}

template <typename T>
inline const T& TVec3<T>::operator[](int n) const
{
	assert(n >= 0 && n <= 2);
	return (&x)[n];
}

template <typename T>
inline T& TVec3<T>::operator[](int n)
{
	assert(n >= 0 && n <= 2);
	return (&x)[n];
}
	
template <typename T>
inline bool TVec3<T>::operator== (const TVec3<T>& a) const
{
	return (x == a.x && y == a.y && z == a.z);
}

template <typename T>
inline TVec3<T> TVec3<T>::operator-() const
{
	return {-x, -y, -z};
}

template <typename T>
inline TVec3<T>& TVec3<T>::operator+= (const TVec3<T>& a)
{
	x += a.x; 
	y += a.y;
	z += a.z;
	return (*this);
}

template <typename T>
inline TVec3<T>& TVec3<T>::operator-= (const TVec3<T>& a)
{
	x -= a.x; 
	y -= a.y;
	z -= a.z;
	return (*this);
}

template <typename T>
inline TVec3<T>& TVec3<T>::operator*= (const T& t)
{
	x *= t; 
	y *= t;
	z *= t;
	return (*this);
}

template <typename T>
inline TVec3<T>& TVec3<T>::operator/= (const T& t)
{
	x /= t; 
	y /= t;
	z /= t;
	return (*this);
}

template <typename T>
inline T TVec3<T>::dot(const TVec3<T>& a) const
{
	return (x * a.x + y * a.y + z * a.z);
}

template <typename T>
inline T TVec3<T>::length() const
{
	return sqrt(x * x + y * y + z * z);
}

template <typename T>
inline TVec3<T> TVec3<T>::cross(const TVec3<T>& a, const TVec3<T>& b)
{
	x = a.y * b.z - a.z * b.y;
	y = a.z * b.x - a.x * b.z;
	z = a.x * b.y - a.y * b.x;
	return (*this);
}

template <typename T>
inline TVec3<T> TVec3<T>::normalize(T desired_length)
{
	(void)desired_length;
	T square = sqrt(x * x + y * y + z * z);
	x /= square;
	y /= square;
	z /= square;
	return (*this);
}

template <typename T>
inline TVec3<T> TVec3<T>::normalize(TVec3<T> a)
{
	return a.normalize();
}

template <typename T>
inline TVec3<T> operator+ (const TVec3<T>& a, const TVec3<T>& b)
{
	return {a.x + b.x, a.y + b.y, a.z + b.z};
}

template <typename T>
inline TVec3<T> operator- (const TVec3<T>& a, const TVec3<T>& b)
{
	return {a.x - b.x, a.y - b.y, a.z - b.z};
}

template <typename T>
inline TVec3<T> operator* (const TVec3<T>& a, const T& t)
{
	return {a.x * t, a.y * t, a.z * t};
}

template <typename T>
inline TVec3<T> operator* (const T& t, const TVec3<T>& a)
{
	return a * t;
}

template <typename T>
inline TVec3<T> operator* (const TVec3<T>& a, const TVec3<T>& b)
{
	return {a.x * b.x, a.y * b.y, a.z * b.z};
}

template <typename T>
inline TVec3<T> operator/ (const TVec3<T>& a, const T& t)
{
	return {a.x / t, a.y / t, a.z / t};
}

template <typename T>
inline TVec3<T> operator/ (const TVec3<T>& a, const TVec3<T>& b)
{
	return {a.x / b.x, a.y / b.y, a.z / b.z};
}

template <typename T>
inline T dot(const TVec3<T>& a, const TVec3<T>& b)
{
	return (a.x * b.x + a.y * b.y + a.z * b.z);
}

template <typename T>
inline TVec3<T> cross(const TVec3<T>& a, const TVec3<T>& b)
{
	return {a.y * b.z - a.z * b.y,
		a.z * b.x - a.x * b.z,
		a.x * b.y - a.y * b.x};
}

template <typename T>
inline T norm(const TVec3<T> a)
{
	return sqrt(dot(a,a));
}

template <typename T>
TVec3<T> normalized(const TVec3<T>& a)
{
	T len = norm(a);
	return (len == 0) ? a : a * (1.f / len);
}

template <typename T>
T max(const TVec3<T>& a)
{
	return (a.y > a.x ? (a.z > a.y ? a.z : a.y) : (a.z > a.x ? a.z : a.x));  
}

template <typename T>
T min(const TVec3<T>& a)
{
	return (a.y < a.x ? (a.z < a.y ? a.z : a.y) : (a.z < a.x ? a.z : a.x));  
}

template <typename T>
TVec3<T> abs(const TVec3<T>& a)
{
	return {a.x < 0 ? -a.x : a.x, 
		a.y < 0 ? -a.y : a.y, 
		a.z < 0 ? -a.z : a.z}; 
}
